/**
 * Local Docker runner provider — emulates a cloud VM provider by spawning
 * runner *containers* on the host's Docker daemon. Used for end-to-end
 * scaling tests without paying for real cloud VMs.
 *
 * Differences from DigitalOcean provider:
 *   - No SSH key, region, or size — those fields on RunnerConfig are ignored.
 *   - No cloud-init: the runner image is expected to already exist locally
 *     (build with `docker build -t crawlee-cloud-runner:local packages/runner`).
 *   - "IP" is not a real IP — we reuse the runnerId so the scaler's heartbeat
 *     lookup at scaler/index.ts:169 (`heartbeats.get(runner.ip)`) succeeds.
 *
 * Selected when SCALER_PROVIDER=local-docker.
 */

import Docker from 'dockerode';
import { nanoid } from 'nanoid';
import type { RunnerProvider, RunnerConfig, RunnerInfo } from '../types.js';

/** Label applied to every container we create, so listRunners() can find them. */
const RUNNER_LABEL = 'crawlee-cloud.scaler-runner';

export class LocalDockerProvider implements RunnerProvider {
  readonly name = 'local-docker';

  private docker = new Docker({
    socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
  });

  async createRunner(_config: RunnerConfig): Promise<RunnerInfo> {
    const runnerId = `local-${nanoid(8)}`;
    const image = process.env.LOCAL_RUNNER_IMAGE || 'crawlee-cloud-runner:local';
    // docker-compose.dev.yml has no `networks:` block, so compose creates
    // `<project>_default`. The project basename here is `crawlee-platfrom`.
    const network = process.env.DOCKER_NETWORK || 'crawlee-platfrom_default';

    // Env vars the runner container needs to come up and heartbeat into Redis.
    // `RUNNER_ID` MUST equal `runnerId` below — that is what links the
    // RunnerInfo we return here with the heartbeat that will appear in Redis.
    //
    // Important: DATABASE_URL/REDIS_URL deliberately do NOT inherit from the
    // host API's process.env, because that points at `localhost:*` which is
    // unreachable from inside the container. We default to compose service
    // names instead, with explicit overrides for non-default setups.
    const env: Record<string, string> = {
      RUNNER_ID: runnerId,
      // API runs on the host; postgres/redis run inside the compose stack.
      // host.docker.internal works on Mac/Windows; on Linux pass
      // `--add-host=host.docker.internal:host-gateway` or set
      // LOCAL_RUNNER_API_BASE_URL to your host IP.
      API_BASE_URL: process.env.LOCAL_RUNNER_API_BASE_URL || 'http://host.docker.internal:3000',
      DATABASE_URL:
        process.env.LOCAL_RUNNER_DATABASE_URL ||
        'postgresql://postgres:postgres@postgres:5432/crawlee_cloud',
      REDIS_URL: process.env.LOCAL_RUNNER_REDIS_URL || 'redis://redis:6379',
      API_TOKEN: process.env.LOCAL_RUNNER_API_TOKEN || 'runner-token',
      DOCKER_SOCKET: '/var/run/docker.sock',
      DOCKER_NETWORK: network,
      MAX_CONCURRENT_RUNS: String(process.env.SCALER_RUNS_PER_RUNNER || '2'),
      LOG_LEVEL: 'info',
    };

    const envArray = Object.entries(env).map(([k, v]) => `${k}=${v}`);

    const container = await this.docker.createContainer({
      name: runnerId,
      Image: image,
      Env: envArray,
      Labels: {
        [RUNNER_LABEL]: 'true',
        'crawlee-cloud.runner-id': runnerId,
      },
      HostConfig: {
        NetworkMode: network,
        Binds: ['/var/run/docker.sock:/var/run/docker.sock'],
        AutoRemove: false, // keep stopped containers around so we can `docker logs` them
        RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      },
    });
    await container.start();

    return {
      id: runnerId,
      ip: runnerId, // the scaler matches heartbeats by id OR ip; both work
      status: 'creating', // the heartbeat will flip this to 'ready'/'busy'
      createdAt: new Date(),
      activeRuns: 0,
    };
  }

  async destroyRunner(id: string): Promise<void> {
    const container = this.docker.getContainer(id);
    try {
      await container.stop({ t: 10 }); // 10s grace period for in-flight runs
    } catch (err) {
      // Already stopped is fine; anything else we'll surface via remove().
      const code = (err as { statusCode?: number }).statusCode;
      if (code !== 304 && code !== 404) throw err;
    }
    try {
      await container.remove({ force: true });
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code !== 404) throw err; // 404 = already gone, fine
    }
  }

  async listRunners(): Promise<RunnerInfo[]> {
    const containers = await this.docker.listContainers({
      all: true, // include stopped — scaler will mark them 'draining' via missing heartbeat
      filters: { label: [`${RUNNER_LABEL}=true`] },
    });

    return containers.map((c) => {
      const runnerId = c.Labels['crawlee-cloud.runner-id'] || c.Id;
      return {
        id: runnerId,
        ip: runnerId,
        status: c.State === 'running' ? 'ready' : 'draining',
        createdAt: new Date(c.Created * 1000),
        activeRuns: 0, // enriched by the scaler from heartbeats
      };
    });
  }
}

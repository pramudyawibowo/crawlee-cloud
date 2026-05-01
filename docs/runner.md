# Runner

The Runner executes Actors in isolated Docker containers.

## How It Works

1. Polls PostgreSQL for runs with `READY` status (using `FOR UPDATE SKIP LOCKED`)
2. Subscribes to Redis `run:new` channel for instant notifications
3. Fetches runner API key from Redis (if not already loaded)
4. Pulls the Actor's Docker image and starts the container
5. Streams logs to Redis during execution
6. Updates run status and cleans up after completion

---

## Configuration

| Variable               | Description                                                  | Default                                                       |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| `API_BASE_URL`         | API server URL                                               | `http://localhost:3000`                                       |
| `API_TOKEN`            | Authentication token (auto-provisioned via Redis if not set) | Auto-provisioned                                              |
| `DATABASE_URL`         | PostgreSQL connection string                                 | `postgresql://postgres:postgres@localhost:5432/crawlee_cloud` |
| `REDIS_URL`            | Redis connection string                                      | `redis://localhost:6379`                                      |
| `DOCKER_SOCKET`        | Docker socket path                                           | `/var/run/docker.sock`                                        |
| `DOCKER_NETWORK`       | Docker network name                                          | `crawlee-cloud_default`                                       |
| `MAX_CONCURRENT_RUNS`  | Max concurrent containers                                    | `10`                                                          |
| `DEFAULT_MEMORY_MB`    | Default container memory (MB)                                | `1024`                                                        |
| `DEFAULT_TIMEOUT_SECS` | Default run timeout (seconds)                                | `3600`                                                        |
| `LOG_LEVEL`            | Log verbosity                                                | `info`                                                        |

> **Note:** On startup, the API server creates a dedicated runner API key and stores it in Redis. The runner automatically fetches this key. You only need to set `API_TOKEN` manually if running the runner outside of the standard Docker Compose setup.

---

## Service Authentication

The runner authenticates with the API server using an auto-provisioned API key:

1. During startup, the API server creates a `cp_`-prefixed API key dedicated to the runner.
2. This key is stored in Redis at `runner:api-key`.
3. On initialization, the runner fetches the key from Redis and uses it as the `APIFY_TOKEN` injected into Actor containers.
4. If the runner starts before the API server is ready, it retries fetching the key on each run.

This removes the need for a hardcoded token and ensures the runner always has a valid credential.

---

## Running

```bash
cd packages/runner
npm run build
npm start
```

### Docker Mode

The Runner needs access to the Docker socket:

```bash
docker run \
  -v /var/run/docker.sock:/var/run/docker.sock \
  crawlee-cloud/runner
```

---

## Container Lifecycle

| Phase   | Description                        |
| ------- | ---------------------------------- |
| Pull    | Download Actor image from registry |
| Create  | Create container with environment  |
| Start   | Execute the container              |
| Monitor | Stream logs, wait for exit         |
| Cleanup | Remove container                   |

---

## Actor Environment Variables

The Runner injects these variables into Actor containers:

| Variable                           | Description                    |
| ---------------------------------- | ------------------------------ |
| `APIFY_API_BASE_URL`               | Points to your API server      |
| `APIFY_TOKEN`                      | Authentication token           |
| `APIFY_ACTOR_RUN_ID`               | Current run ID                 |
| `APIFY_DEFAULT_DATASET_ID`         | Default dataset for `pushData` |
| `APIFY_DEFAULT_KEY_VALUE_STORE_ID` | Default KV store               |
| `APIFY_DEFAULT_REQUEST_QUEUE_ID`   | Default request queue          |

Environment variables are merged in order: base env < actor env (from actor.json) < runtime env (from CLI `-e` flag).

---

## Graceful Shutdown

On SIGTERM/SIGINT:

1. Stop accepting new jobs
2. Wait for running containers to finish
3. Clean up resources
4. Exit

---

## Auto-scaling

The API server can automatically provision and destroy runner VMs based on queue pressure. Disabled by default — set `SCALER_ENABLED=true` to opt in. Has zero impact on single-Droplet or docker-compose deployments.

### Providers

| Provider       | When to use                                                                       |
| -------------- | --------------------------------------------------------------------------------- |
| `noop`         | Default. Scaler runs but takes no action. Useful for testing config.              |
| `local-docker` | Spins up runner containers on the same Docker daemon. Dev / single-host setups.   |
| `digitalocean` | Creates and destroys DigitalOcean Droplets. Requires `DO_TOKEN` and `SSH_KEY_ID`. |

### Core scaler variables

| Variable                        | Default       | Description                                                                                                         |
| ------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------- |
| `SCALER_ENABLED`                | `false`       | Set to `true` to start the scaling loop.                                                                            |
| `SCALER_PROVIDER`               | `noop`        | One of `noop`, `local-docker`, `digitalocean`.                                                                      |
| `SCALER_MIN_RUNNERS`            | `1`           | Minimum runners kept warm at all times.                                                                             |
| `SCALER_MAX_RUNNERS`            | `5`           | Hard cap on provisioned runners. Clamped to `>= MIN_RUNNERS`.                                                       |
| `SCALER_SCALE_UP_THRESHOLD`     | `5`           | Don't scale up unless `READY` queue depth exceeds this (and we're already at `MIN_RUNNERS`).                        |
| `SCALER_RUNS_PER_RUNNER`        | `5`           | How many concurrent runs each runner can handle. Drives demand math: `desired = ceil(totalDemand / runsPerRunner)`. |
| `SCALER_POLL_INTERVAL_SECS`     | `30`          | How often the scaler evaluates demand.                                                                              |
| `SCALER_IDLE_TIMEOUT_SECS`      | `600`         | After the queue empties, wait this long before scaling down. Avoids thrashing during natural lulls.                 |
| `SCALER_REAPER_DEAD_AFTER_SECS` | `180`         | A booting runner with no heartbeat for longer than this is marked `dead` and destroyed. Bump on slow apt mirrors.   |
| `SCALER_RUNNER_SIZE`            | `s-2vcpu-4gb` | Provider-specific instance size (DigitalOcean droplet slug).                                                        |
| `SCALER_RUNNER_REGION`          | `nyc1`        | Provider-specific region.                                                                                           |
| `SCALER_SSH_KEY_ID`             | _(empty)_     | DigitalOcean SSH key fingerprint or ID — required for `digitalocean` provider so you can shell in for forensics.    |
| `SCALER_API_BASE_URL`           | _(empty)_     | URL the freshly-booted runner will call back to. Must be reachable from the runner VM.                              |

### Cloud / registry credentials

| Variable               | Default   | Description                                                                                                                       |
| ---------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `DO_TOKEN`             | _(empty)_ | DigitalOcean API token. `DIGITALOCEAN_TOKEN` is accepted as an alias.                                                             |
| `IMAGE_REGISTRY`       | _(empty)_ | Registry to pull actor images from (e.g. `ghcr.io/your-org`). Without it, runners require local image builds.                     |
| `IMAGE_REGISTRY_USER`  | _(empty)_ | Username for the registry login.                                                                                                  |
| `IMAGE_REGISTRY_TOKEN` | _(empty)_ | Token / password for the registry login.                                                                                          |
| `GHCR_TOKEN`           | _(empty)_ | GitHub Container Registry PAT. Inlined into the runner's cloud-init so it can `docker login ghcr.io` before pulling actor images. |
| `GHCR_REPO`            | _(empty)_ | GHCR repository slug used for image lookups.                                                                                      |

### Security flags

| Variable              | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCALER_INSECURE_TLS` | `false` | ⚠️ **Opt-in TLS bypass.** When `true`, freshly-provisioned runners boot with `NODE_TLS_REJECT_UNAUTHORIZED=0`, disabling cert verification on every outbound HTTPS call. Only valid use case: trusted internal CAs / self-signed certs the runner can't otherwise verify. The API logs a warning at startup when set. **Do not enable on the public internet** — every call to your API, S3, or registries becomes MITM-vulnerable. |
| `METRICS_PUBLIC`      | `false` | When `true`, `GET /metrics` is exposed without auth. By default the endpoint is admin-only because it leaks process internals and per-route counters useful for fingerprinting. Use only when your Prometheus scraper can't pass an `Authorization` header (private network).                                                                                                                                                       |

### Status endpoint

`GET /v2/scaler/status` (admin-only) returns the live runner list, heartbeats, queue stats, and config. There is intentionally no `_PUBLIC` flag — the response includes runner IPs and provider config that have no public use case.

### Operational notes

- **Cloud-init secrets:** the cloud-init script that bootstraps each runner contains `DATABASE_URL`, `REDIS_URL`, and registry tokens in plaintext. On DigitalOcean this is readable from the metadata service (`http://169.254.169.254/metadata/v1/user-data`) by anything running on the VM, including actor containers if you don't firewall the metadata IP. Treat runner VMs as having access to those secrets.
- **Scaling math:** `desired = ceil((ready + running) / runsPerRunner)`, clamped to `[MIN_RUNNERS, MAX_RUNNERS]`. When the queue is empty, scale-down only happens after `IDLE_TIMEOUT_SECS` of continuous idleness — preventing churn during normal traffic dips.
- **Reaper:** runners with no heartbeat for `REAPER_DEAD_AFTER_SECS` are marked `dead` and destroyed every tick, independent of demand. Failed destroys stay in the runner list so the next tick retries — this preserves capacity accounting.

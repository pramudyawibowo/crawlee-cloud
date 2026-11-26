/**
 * Docker container executor.
 *
 * This module handles:
 * - Pulling Actor images (with singleflight dedup, TTL freshness cache & digest skip)
 * - Creating containers with proper environment variables
 * - Starting and monitoring containers
 * - Collecting logs and exit codes
 */

import os from 'node:os';
import Docker from 'dockerode';
import { Redis } from 'ioredis';
import { config, type ImagePullPolicy } from './config.js';
import { getDiskUsageRatio } from './heartbeat.js';
import { waitWithTimeout } from './wait.js';

let warnedAboutDarwinTranslate = false;

/**
 * Rewrite `localhost` / `127.0.0.1` hosts to `host.docker.internal` when the
 * runner is on macOS. Reason: when the runner runs on the host (typical local
 * dev) and spawns an actor container, `localhost` inside the actor resolves
 * to the actor container itself, not the API on the host. Docker Desktop on
 * macOS provides `host.docker.internal` for this exact case.
 *
 * Linux runners are *not* translated — `host.docker.internal` doesn't resolve
 * by default there, and production Linux deploys typically use a reachable
 * service hostname (compose service name, k8s service, etc.) rather than
 * localhost. Touching the URL on Linux would break those setups.
 *
 * Exported for unit testing — `platform` is parameterised so tests don't have
 * to monkey-patch `os.platform()`.
 */
export function translateLocalhostForContainer(
  url: string,
  platform: string = os.platform()
): string {
  if (platform !== 'darwin') return url;
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
      u.hostname = 'host.docker.internal';
      if (!warnedAboutDarwinTranslate) {
        // process.stderr.write flushes synchronously when stderr is a file
        // (the long-running runner case under `npm run start > log 2>&1`),
        // unlike console.warn which line-buffers and only drains at exit.
        // Operators triaging a stuck dev setup need to see this warning live.
        process.stderr.write(
          `[Runner] Rewriting actor APIFY_API_BASE_URL host -> host.docker.internal ` +
            `(macOS dev convenience). Set API_BASE_URL explicitly to silence this.\n`
        );
        warnedAboutDarwinTranslate = true;
      }
      return u.toString().replace(/\/$/, '');
    }
  } catch {
    // If apiBaseUrl isn't a valid URL, leave it alone — caller will error.
  }
  return url;
}

export interface RunOptions {
  runId: string;
  actorId: string;
  image: string;

  // Environment variables to inject (Apify-compatible)
  env: Record<string, string>;

  // Resource limits
  memoryMb?: number;
  timeoutSecs?: number;

  /**
   * Polled after the image pull, before the container is created. Covers
   * the abort-during-pull window: run:abort → stopRun finds no container
   * (it doesn't exist yet) → without this check the container would start
   * anyway and run to natural exit or timeout, pinning the runner busy.
   */
  isAborted?: () => boolean;
}

export interface RunResult {
  exitCode: number;
  startedAt: Date;
  finishedAt: Date;
  /**
   * True when Docker reports `State.OOMKilled` for the finished container.
   * The exit code alone can't distinguish OOM: the kernel's OOM killer
   * produces 137, but so does `docker stop`; and when it SIGKILLs a child
   * process instead of PID 1, the container exits 1 like any crash.
   */
  oomKilled: boolean;
  /**
   * Peak observed working-set memory in MB, sampled from the Docker stats
   * API while the container ran. Null = unmeasured (run shorter than one
   * tick, aborted before start, or stats failures).
   * Persisted to runs.peak_memory_mb — the basis for per-actor memory
   * right-sizing.
   */
  peakMemoryMb: number | null;
}

const docker = new Docker({
  socketPath: config.dockerSocketPath,
});

// Redis for log streaming
const redis = new Redis(config.redisUrl);
redis.on('error', (err) => {
  console.warn(`[Runner/Docker] Redis error: ${err.message}`);
});

// ---- Image pull coordination & LRU tracking ----

/** Active pull promises keyed by image ref (singleflight deduplication). */
const inFlightPulls = new Map<string, Promise<void>>();
/** Abort predicates of all callers currently awaiting each in-flight pull. */
const inFlightWaiters = new Map<string, Set<() => boolean>>();
/** Epoch ms when an image ref was last verified/pulled from a remote registry. */
const imageLastPulledAt = new Map<string, number>();
/** Epoch ms when an image ref was last used by a run (feeds LRU disk eviction). */
const imageLastUsedAt = new Map<string, number>();

/**
 * Invalidate cached pull freshness for a specific image (or all images when
 * omitted). Called when the API notifies runners via Redis `actor:image-updated`
 * after an actor push/update, or when cleanup evicts an image tag.
 */
export function invalidateImagePullCache(image?: string): void {
  if (image) {
    imageLastPulledAt.delete(image);
  } else {
    imageLastPulledAt.clear();
  }
}

/** Reset in-memory pull/LRU maps (unit test helper). */
export function resetImagePullState(): void {
  inFlightPulls.clear();
  inFlightWaiters.clear();
  imageLastPulledAt.clear();
  imageLastUsedAt.clear();
}

/**
 * True when an image ref is pinned to an immutable content digest
 * (e.g. `ghcr.io/org/actor:latest@sha256:...` or `ghcr.io/org/actor@sha256:...`).
 * Content-addressed refs cannot change upstream — once present locally,
 * re-pulling is always redundant.
 */
export function isImmutableImageRef(image: string): boolean {
  return /@sha(?:256|512):[0-9a-fA-F]{64,128}$/.test(image);
}

/**
 * True when `image` lives under the configured `IMAGE_REGISTRY` prefix.
 * Uses boundary-aware prefix matching rather than loose `.includes()`.
 */
export function isConfiguredRegistryImage(image: string, registry: string): boolean {
  const normalized = registry.trim().replace(/\/+$/, '');
  if (!normalized) return false;
  return image === normalized || image.startsWith(`${normalized}/`);
}

/**
 * Classify whether a docker pull error is transient and worth retrying.
 * Permanent errors (404/manifest unknown, auth failure, invalid ref, full disk)
 * will never succeed 5s later — failing fast avoids wasting 20s and holding
 * a concurrency slot.
 */
export function isRetryablePullError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  const permanentPatterns = [
    'manifest unknown',
    'not found',
    'http code 404',
    'http code 401',
    'http code 403',
    'http code 400',
    'unauthorized',
    'authentication required',
    'denied',
    'pull access denied',
    'repository does not exist',
    'invalid reference format',
    'no space left on device',
  ];
  return !permanentPatterns.some((p) => msg.includes(p));
}

/**
 * Minimal Redis surface the log writer needs — lets tests inject a mock
 * without a live server. Pipeline-shaped (PR #57 review): the writer
 * issues one round-trip per BATCH instead of four per line, which is
 * what caps flush throughput (and thus the boundedFlush backlog) under
 * chatty actors. Matches ioredis' ChainableCommander structurally.
 */
export interface LogRedisPipeline {
  rpush(key: string, value: string): unknown;
  ltrim(key: string, start: number, stop: number): unknown;
  expire(key: string, seconds: number): unknown;
  publish(channel: string, message: string): unknown;
  set(key: string, value: string): unknown;
  exec(): Promise<Array<[error: Error | null, result: unknown]> | null>;
}
export interface LogRedis {
  pipeline(): LogRedisPipeline;
}

export interface RunMetricSnapshot {
  runId: string;
  timestamp: string;
  usedMb: number;
  limitMb: number;
  percent: number;
  peakMemoryMb: number;
}

/**
 * Best-effort pipelined writer for realtime run metrics (RAM usage, peak).
 * Stores latest snapshot in metrics:<runId>, pushes to metrics:history:<runId> (capped at 120 points),
 * and publishes to metrics:<runId> for live subscribers.
 * Exported for unit tests.
 */
export async function writeRunMetrics(
  client: LogRedis,
  runId: string,
  metric: RunMetricSnapshot
): Promise<void> {
  const metricJson = JSON.stringify(metric);
  const key = `metrics:${runId}`;
  const historyKey = `metrics:history:${runId}`;
  try {
    const pipe = client.pipeline();
    pipe.set(key, metricJson);
    pipe.expire(key, 86400);
    pipe.rpush(historyKey, metricJson);
    pipe.ltrim(historyKey, -120, -1);
    pipe.expire(historyKey, 86400);
    pipe.publish(key, metricJson);
    const results = await pipe.exec();
    if (results === null) return;
    const firstErr = results.find(([err]) => err !== null)?.[0];
    if (firstErr) throw firstErr;
  } catch (err) {
    console.warn(`[${runId}] Failed to record run metrics: ${(err as Error).message}`);
  }
}

/**
 * Serialized, error-tolerant writer for a run's streamed log lines.
 *
 * Replaces the previous fire-and-forget async closures (one per Docker
 * 'data' event), which had two prod-observed failure modes: overlapping
 * closures interleaved their rpushes so lines landed out of order, and a
 * rejected Redis command (ioredis flushes pending commands with
 * MaxRetriesPerRequestError after 20 reconnect attempts) became an
 * unhandled rejection — fatal on Node 20 — killing the runner and
 * orphaning every container it supervised. Dropping the batch with a
 * warning is the correct degraded mode: a log line is never worth the
 * process.
 *
 * Exported for unit tests.
 */
export function createLogLineWriter(
  client: LogRedis,
  runId: string
): { enqueue: (entries: string[]) => void; drain: () => Promise<void> } {
  const key = `logs:${runId}`;
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (entries: string[]): void => {
    if (entries.length === 0) return;
    chain = chain
      .then(async () => {
        // One pipelined round-trip per batch (PR #57 review) instead of
        // four awaited commands per LINE: per-entry rpush+publish keep
        // list order and subscriber order intact, while ltrim/expire are
        // cap/TTL maintenance that only need to run once per batch (the
        // list transiently exceeds the cap by at most the batch size,
        // trimmed in the same round-trip; the first batch still sets the
        // TTL, preserving the no-immortal-key invariant).
        const pipe = client.pipeline();
        for (const entry of entries) {
          pipe.rpush(key, entry);
          pipe.publish(key, entry);
        }
        pipe.ltrim(key, -1000, -1);
        pipe.expire(key, 86400);
        const results = await pipe.exec();
        // ioredis exec() only rejects on connection-level failures;
        // per-command errors come back in the result tuples and a null
        // result means the pipeline was discarded. Surface both so the
        // batch takes the drop-warning path instead of vanishing quietly.
        if (results === null) throw new Error('pipeline discarded (connection lost)');
        const firstErr = results.find(([err]) => err !== null)?.[0];
        if (firstErr) throw firstErr;
      })
      .catch((err: unknown) => {
        console.warn(
          `[${runId}] Dropped ${String(entries.length)} log line(s) — Redis write failed: ${(err as Error).message}`
        );
      });
  };

  // Resolves once everything enqueued SO FAR has been written or dropped.
  const drain = (): Promise<void> => chain;

  return { enqueue, drain };
}

/**
 * Best-effort single write for lifecycle markers (start / pull / abort /
 * timeout / finish / failure-cause). Logging must never decide a run's
 * fate: these sit on the executeRun/processRun spine, where an unguarded
 * Redis rejection would flip a healthy run FAILED with a Redis error as
 * its status message. Sets the same 24h TTL as the streamed lines so a
 * terminal marker also refreshes the autopsy window; deliberately no
 * ltrim — the finish marker must survive the 1000-line cap.
 */
export async function writeLifecycleLog(
  runId: string,
  level: 'INFO' | 'WARN' | 'ERROR',
  message: string
): Promise<void> {
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), level, message });
  try {
    await redis.rpush(`logs:${runId}`, entry);
    await redis.expire(`logs:${runId}`, 86400);
  } catch (err) {
    console.warn(`[${runId}] Lifecycle log write failed: ${(err as Error).message}`);
  }
}

/**
 * Stream container logs to Redis in real-time.
 *
 * Returns a bounded flush handle: it resolves once the attach stream has
 * ended AND all enqueued writes have landed, or after `timeoutMs` —
 * whichever comes first. executeRun awaits it before writing the finish
 * marker so "Container finished ..." actually lands after the container's
 * final output; the bound guarantees a wedged attach stream can never
 * stall run terminalization.
 */
async function streamLogs(
  container: Docker.Container,
  runId: string
): Promise<(timeoutMs: number) => Promise<void>> {
  const logStream = await container.attach({
    stream: true,
    stdout: true,
    stderr: true,
  });

  const writer = createLogLineWriter(redis, runId);
  let buffer = '';
  let markEnded: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    markEnded = resolve;
  });

  const toEntry = (cleanLine: string): string =>
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: cleanLine.toLowerCase().includes('error')
        ? 'ERROR'
        : cleanLine.toLowerCase().includes('warn')
          ? 'WARN'
          : 'INFO',
      message: cleanLine,
    });

  logStream.on('data', (chunk: Buffer) => {
    // Parsing stays synchronous so `buffer` is never mutated concurrently;
    // only the Redis writes go through the serialized chain.
    // Docker multiplexes stdout/stderr, first 8 bytes are header
    // For simplicity, we'll just process the raw output
    const text = chunk.toString('utf-8');
    buffer += text;

    // Process complete lines
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

    const entries: string[] = [];
    for (const line of lines) {
      if (line.trim()) {
        // Clean Docker multiplex header if present (first 8 bytes per frame)
        // eslint-disable-next-line no-control-regex
        const cleanLine = line.replace(/^[\x00-\x08]/g, '').trim();
        if (cleanLine) entries.push(toEntry(cleanLine));
      }
    }
    writer.enqueue(entries);
  });

  // Flush remaining buffer on end
  logStream.on('end', () => {
    if (buffer.trim()) {
      writer.enqueue([toEntry(buffer.trim())]);
      buffer = '';
    }
    markEnded();
  });
  // The attach socket can error (daemon restart, connection reset); treat
  // it as end-of-stream, flushing the buffered partial line first — a
  // crashing actor's final diagnostic is often written without a trailing
  // newline, and after 'error' no 'end' fires to flush it. Idempotent with
  // 'end' via the trim guard + buffer reset.
  logStream.on('error', (err: Error) => {
    console.warn(`[${runId}] Log stream error: ${err.message}`);
    if (buffer.trim()) {
      writer.enqueue([toEntry(buffer.trim())]);
      buffer = '';
    }
    markEnded();
  });

  return (timeoutMs: number) => boundedFlush(ended, () => writer.drain(), timeoutMs);
}

/**
 * Resolve on (ended AND drained) or after timeoutMs — whichever comes
 * first. The bound must cover BOTH waits: a wedged attach stream ('end'
 * never fires) and a Redis-outage backlog (drain never settles — ioredis
 * has no command timeout, and a black-holed connection can hold the write
 * chain open indefinitely) must be equally unable to stall run
 * terminalization. Abandoning the drain at the deadline is safe: every
 * chain link ends in .catch, so late writes land or drop quietly in the
 * background. Exported for unit tests.
 */
export function boundedFlush(
  ended: Promise<void>,
  drain: () => Promise<void>,
  timeoutMs: number
): Promise<void> {
  const timeout = new Promise<void>((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    t.unref();
  });
  return Promise.race([ended.then(drain), timeout]);
}

/** How often executeRun samples container memory for real-time tracking (1 second). */
export const STATS_SAMPLE_INTERVAL_MS = 1000;

/**
 * Working-set memory in MB from a Docker stats snapshot, or null when the
 * frame is malformed. Mirrors what `docker stats` displays: usage minus
 * reclaimable page cache — `inactive_file` on cgroup v2 hosts,
 * `total_inactive_file` on v1 — because raw `usage` includes file cache
 * the kernel would reclaim under pressure and wildly overstates a
 * scraper's real footprint. Exported for unit tests.
 */
export function memoryUsageMbFromStats(stats: unknown): number | null {
  const mem = (stats as { memory_stats?: { usage?: unknown; stats?: Record<string, unknown> } })
    ?.memory_stats;
  if (!mem || typeof mem.usage !== 'number' || !Number.isFinite(mem.usage)) return null;
  // v1-first (total_inactive_file), matching Docker's own
  // calculateMemUsageUnixNoCache: on cgroup v1 BOTH keys exist and the
  // leaf-only inactive_file misses child cgroups' cache; v2 hosts only
  // have inactive_file, so the fallthrough is safe.
  const inactiveRaw = mem.stats?.['total_inactive_file'] ?? mem.stats?.['inactive_file'];
  const inactive =
    typeof inactiveRaw === 'number' && Number.isFinite(inactiveRaw) ? inactiveRaw : 0;
  return Math.max(0, Math.round((mem.usage - inactive) / (1024 * 1024)));
}

/**
 * Cap a run's container memory limit at what the host can actually honor.
 *
 * A cgroup limit >= physical RAM is unenforceable: the kernel OOM killer
 * fires at HOST exhaustion instead of the container's limit, and picks its
 * own victim — sometimes the actor container (clean FAILED), sometimes
 * dockerd or the runner itself (wedged droplet, dead heartbeat, zombie
 * runs — both observed in prod 2026-07-16, retailmenot at 4096MB on
 * 3912MB hosts). Clamping converts "host OOM roulette" into a normal
 * container OOM at a limit the kernel can enforce. The 256MB floor keeps
 * a misconfigured reserve (>= total RAM) from producing an unusable cap.
 *
 * Exported for unit tests and for queue.ts (the claim gate and
 * APIFY_MEMORY_MBYTES must use the same effective value).
 */
export function clampMemoryToHost(
  requestedMb: number,
  hostTotalMb: number,
  reserveMb: number
): number {
  const usable = Math.max(256, hostTotalMb - reserveMb);
  return Math.min(requestedMb, usable);
}

/**
 * Execute an Actor in a Docker container.
 */
export async function executeRun(options: RunOptions): Promise<RunResult> {
  const { runId, actorId, image, env, timeoutSecs = config.defaultTimeoutSecs } = options;

  // Defensive re-clamp: queue.ts already clamps before building the actor
  // env, but this is the single point where the limit reaches Docker, so
  // enforce the invariant here too (idempotent when already clamped).
  const requestedMb = options.memoryMb ?? config.defaultMemoryMb;
  const memoryMb = clampMemoryToHost(requestedMb, config.hostTotalMemoryMb, config.memoryReserveMb);

  console.log(`[${runId}] Starting container for Actor ${actorId}`);
  console.log(`[${runId}] Image: ${image}`);

  // Log start message to Redis
  await writeLifecycleLog(runId, 'INFO', `Starting Actor ${actorId} with image ${image}`);
  if (memoryMb < requestedMb) {
    await writeLifecycleLog(
      runId,
      'WARN',
      `Requested memory ${String(requestedMb)}MB exceeds host capacity; limit clamped to ${String(memoryMb)}MB`
    );
  }

  const startedAt = new Date();

  // Build environment variables array
  const envArray = Object.entries(env).map(([key, value]) => `${key}=${value}`);

  // Pull image if not exists (or stale)
  try {
    await pullImageIfNeeded(image, runId, options.isAborted);
  } catch (err) {
    console.error(`[${runId}] Failed to pull image:`, err);
    await writeLifecycleLog(runId, 'ERROR', `Failed to pull image: ${String(err)}`);
    // Re-prefix by failure SITE, not message shape: followPull only tags
    // in-band daemon frames, so transport-level failures (registry
    // outage, DNS, socket reset) reject with raw messages that
    // isInfraFailure (queue.ts) would misclassify as actor failures —
    // terminal for max_retries=0 actors, which is exactly the population
    // the infra retry floor exists for.
    // Always throw an Error: processRun's catch reads `.message`, and a
    // rethrown non-Error rejection (e.g. a raw string) would make that
    // undefined — sanitizeStatusMessage then throws INSIDE the failure
    // handler and the run never reaches a terminal state.
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && message.startsWith('Image pull failed')) throw err;
    throw new Error(
      message.startsWith('Image pull failed') ? message : `Image pull failed: ${message}`
    );
  }

  // Abort may have landed during the pull, when there was no container
  // for stopRun to stop. Bail before creating one — the run's status is
  // already terminal (ABORTED) in the DB; processRun's guarded UPDATE
  // no-ops and fires the ACTOR.RUN.ABORTED webhook from the re-read.
  if (options.isAborted?.()) {
    console.log(`[${runId}] Run aborted during image pull — not starting container`);
    await writeLifecycleLog(runId, 'WARN', 'Run aborted before container start');
    return {
      exitCode: 137,
      startedAt,
      finishedAt: new Date(),
      oomKilled: false,
      peakMemoryMb: null,
    };
  }

  // Create container
  const container = await docker.createContainer({
    Image: image,
    Env: envArray,
    HostConfig: {
      Memory: memoryMb * 1024 * 1024,
      MemorySwap: memoryMb * 1024 * 1024 * 2,
      NetworkMode: config.dockerNetwork,
      AutoRemove: false, // We'll remove after collecting logs
    },
    Labels: {
      'crawlee-cloud.run-id': runId,
      'crawlee-cloud.actor-id': actorId,
    },
  });

  console.log(`[${runId}] Container created: ${container.id}`);

  // Recheck after creation: an abort landing between the pre-create check
  // and start() would otherwise slip through — at that moment the abort
  // handler's stopRun can only act on the container if it exists, and the
  // container must never start. Remove the created-but-unstarted container
  // and bail. (stopRun also lists with all:true for the same reason — the
  // two sides close the window from both ends.)
  if (options.isAborted?.()) {
    console.log(`[${runId}] Run aborted after container create — removing without start`);
    await container.remove({ force: true }).catch(() => {});
    await writeLifecycleLog(runId, 'WARN', 'Run aborted before container start');
    return {
      exitCode: 137,
      startedAt,
      finishedAt: new Date(),
      oomKilled: false,
      peakMemoryMb: null,
    };
  }

  // Start streaming logs BEFORE starting container
  const flushLogs = await streamLogs(container, runId);

  // Start container
  await container.start();
  console.log(`[${runId}] Container started`);

  // Peak working-set sampling for per-actor right-sizing. Guard against
  // overlapping `container.stats({ stream: false })` calls: Docker's
  // one-shot stats API takes ~1s per call (computing CPU deltas), so an
  // unguarded 1s interval piles up concurrent daemon requests under load.
  let peakMemoryMb: number | null = null;
  let statsInFlight = false;
  let statsStopped = false;
  const statsTimer = setInterval(() => {
    if (statsInFlight || statsStopped) return;
    statsInFlight = true;
    void (async () => {
      try {
        const stats: unknown = await container.stats({ stream: false });
        if (statsStopped) return;
        const usedMb = memoryUsageMbFromStats(stats);
        if (usedMb !== null) {
          if (usedMb > (peakMemoryMb ?? -1)) peakMemoryMb = usedMb;
          const limitMb = memoryMb ?? 1024;
          const percent =
            limitMb > 0 ? Math.min(100, Math.round((usedMb / limitMb) * 1000) / 10) : 0;
          await writeRunMetrics(redis, runId, {
            runId,
            timestamp: new Date().toISOString(),
            usedMb,
            limitMb,
            percent,
            peakMemoryMb: peakMemoryMb ?? usedMb,
          });
        }
      } catch {
        // Container exited between ticks, or a stats-API hiccup — fine.
      } finally {
        statsInFlight = false;
      }
    })();
  }, STATS_SAMPLE_INTERVAL_MS);
  statsTimer.unref();

  // Wait for completion with timeout
  let exitCode = 0;

  const waited = await waitWithTimeout(
    container.wait() as Promise<{ StatusCode: number }>,
    timeoutSecs * 1000
  ).finally(() => {
    statsStopped = true;
    clearInterval(statsTimer);
  });

  if (waited.timedOut) {
    console.log(`[${runId}] Container timed out, stopping...`);
    await writeLifecycleLog(runId, 'WARN', 'Container execution timed out');
    try {
      await container.stop({ t: 10 });
    } catch (err) {
      // Container may have exited or been removed in the race window
      // (e.g. periodic cleanup). A throw here used to escape and flip
      // the run FAILED — the run DID time out, keep 143.
      console.warn(`[${runId}] Stop after timeout failed: ${(err as Error).message}`);
    }
    exitCode = 143; // SIGTERM
  } else {
    exitCode = waited.value.StatusCode;
  }

  const finishedAt = new Date();

  // Read OOM state BEFORE remove() — inspect on a removed container 404s.
  // Best-effort: a failed inspect must not break run terminalization.
  let oomKilled = false;
  try {
    const info = await container.inspect();
    oomKilled = info.State?.OOMKilled === true;
  } catch (err) {
    console.warn(`[${runId}] Inspect after exit failed: ${(err as Error).message}`);
  }

  // Let the attach stream deliver the container's final lines before the
  // finish marker, so "Container finished ..." lands last. Bounded: the
  // container has already exited, so 'end' normally arrives within ms; a
  // wedged stream must not delay terminalization.
  await flushLogs(2000);

  // Log finish message
  await writeLifecycleLog(
    runId,
    exitCode === 0 ? 'INFO' : 'ERROR',
    `Container finished with exit code ${String(exitCode)}${oomKilled ? ' (OOM-killed)' : ''}`
  );

  // Remove container. Best-effort: between wait() and here the container
  // sits in 'exited' state, where the 30-minute cleanup sweep can remove
  // it first. A 404/409 from that race must not escape — it would land in
  // processRun's catch, flip this finished (possibly exit-0) run to
  // FAILED, and even re-execute it via maybeRetryRun.
  try {
    await container.remove();
    console.log(`[${runId}] Container removed`);
  } catch (err) {
    console.warn(
      `[${runId}] Container remove failed (already removed?): ${(err as Error).message}`
    );
  }

  console.log(`[${runId}] Finished with exit code ${String(exitCode)}`);

  return {
    exitCode,
    startedAt,
    peakMemoryMb,
    finishedAt,
    oomKilled,
  };
}

/** Registry auth for docker pull (only sent when pulling from the configured registry host). */
function getRegistryAuth(
  image: string
): { authconfig?: { username: string; password: string; serveraddress: string } } | undefined {
  if (!config.imageRegistry || !config.imageRegistryToken) return undefined;
  const serveraddress = config.imageRegistry.split('/')[0] || '';
  if (!serveraddress || !image.startsWith(`${serveraddress}/`)) return undefined;
  return {
    authconfig: {
      username: config.imageRegistryUser || 'github',
      password: config.imageRegistryToken,
      serveraddress,
    },
  };
}

/** A single JSON frame from docker's pull progress stream. */
export interface PullProgressEvent {
  status?: string;
  error?: string;
  errorDetail?: { message?: string };
}

/** The slice of docker-modem that followPull consumes — injectable for tests. */
export interface PullModem {
  followProgress: (
    stream: NodeJS.ReadableStream,
    onFinished: (err: Error | null) => void,
    onProgress?: (event: PullProgressEvent) => void
  ) => void;
}

/**
 * Follow a docker pull stream to completion, surfacing IN-BODY errors.
 *
 * docker-modem's followProgress treats a clean stream end as success: it
 * never inspects individual frames, but the daemon reports pull failures
 * (disk full, auth, registry rate-limit) as `{"error": ...}` frames on an
 * HTTP 200 stream — the transport 'error' event never fires for those.
 * Verified against docker-modem 5.0.6 (lib/modem.js processLine /
 * onStreamEnd). Without this check a failed pull logs "pulled
 * successfully" and the run dies two calls later at createContainer with
 * a misleading "(HTTP code 404) No such image".
 *
 * Exported for unit tests (fake modem).
 */
export function followPull(modem: PullModem, stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let inBandError: Error | null = null;
    modem.followProgress(
      stream,
      (err: Error | null) => {
        if (err) {
          reject(err);
        } else if (inBandError) {
          reject(inBandError);
        } else {
          resolve();
        }
      },
      (event: PullProgressEvent) => {
        if (!inBandError && (event.error || event.errorDetail?.message)) {
          inBandError = new Error(
            `Image pull failed: ${event.errorDetail?.message ?? event.error ?? 'unknown daemon error'}`
          );
        }
      }
    );
  });
}

/**
 * Run `attempt` up to `delaysMs.length + 1` times, sleeping between tries.
 * Returns on the first success; throws the LAST error once retries are
 * exhausted, `isAborted()` returns true, or `shouldRetry(err)` returns false.
 * `onRetry` fires before each sleep with the attempt number and the error
 * that caused it. Exported for unit tests (docker-pull.test.ts).
 */
export async function pullWithRetries(
  attempt: () => Promise<void>,
  opts: {
    delaysMs: number[];
    /** Abort check between attempts — a retry window must not extend an
     * aborted run's hold on its concurrency slot and memory headroom. */
    isAborted?: () => boolean;
    /** Optional predicate to skip retries on permanent errors (404, 401, ENOSPC). */
    shouldRetry?: (err: Error) => boolean;
    onRetry?: (attemptNo: number, err: Error) => void | Promise<void>;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; ; i++) {
    try {
      await attempt();
      return;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (
        i >= opts.delaysMs.length ||
        opts.isAborted?.() ||
        (opts.shouldRetry && !opts.shouldRetry(error))
      ) {
        throw err;
      }
      await opts.onRetry?.(i + 1, error);
      await sleep(opts.delaysMs[i] ?? 0);
    }
  }
}

/**
 * Await a shared in-flight pull, waking early if this caller is aborted so
 * the aborted run releases its concurrency slot without cancelling the pull
 * for other active runs sharing the same image.
 */
async function waitForPullOrAbort(
  pullPromise: Promise<void>,
  isAborted?: () => boolean
): Promise<void> {
  if (!isAborted) return pullPromise;
  if (isAborted()) return;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    await Promise.race([
      pullPromise,
      new Promise<void>((resolve) => {
        timer = setInterval(() => {
          if (isAborted()) resolve();
        }, 250);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearInterval(timer);
  }
}

export interface PullImageDeps {
  dockerClient?: Pick<Docker, 'getImage' | 'pull' | 'modem'>;
  now?: () => number;
  policy?: ImagePullPolicy;
  cacheTtlSecs?: number;
  imageRegistry?: string;
  log?: (runId: string, level: 'INFO' | 'WARN' | 'ERROR', message: string) => Promise<void>;
  pullOnceFn?: (image: string) => Promise<void>;
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Pull Docker image if not already present / fresh.
 *
 * Optimizations over unconditional per-run pulls:
 * 1. **Local / immutable skip**: local images and `@sha256:` digest refs skip
 *    remote pulls whenever present locally (~2ms inspect).
 * 2. **Smart TTL freshness cache (`IMAGE_PULL_POLICY=smart`, default 300s)**:
 *    mutable registry tags (e.g. `:latest`) skip redundant registry round-trips
 *    while fresh locally, and are immediately invalidated via Redis
 *    `actor:image-updated` whenever an actor is pushed/updated.
 *    Set `IMAGE_PULL_POLICY=if-not-present` to always use cached local images,
 *    or `IMAGE_PULL_POLICY=always` to check the registry on every run.
 * 3. **Singleflight deduplication**: concurrent runs for the same image share
 *    a single `docker.pull()` instead of slamming dockerd & the registry with
 *    N parallel multi-GB downloads.
 * 4. **Fast-fail permanent errors**: 404/401/403/ENOSPC abort immediately
 *    instead of burning 20s in retry backoff.
 */
export async function pullImageIfNeeded(
  image: string,
  runId: string,
  isAborted?: () => boolean,
  deps: PullImageDeps = {}
): Promise<void> {
  const client = deps.dockerClient ?? docker;
  const now = deps.now ?? Date.now;
  const policy = deps.policy ?? config.imagePullPolicy;
  const cacheTtlSecs = deps.cacheTtlSecs ?? config.imagePullCacheTtlSecs;
  const registry = deps.imageRegistry ?? config.imageRegistry;
  const log = deps.log ?? writeLifecycleLog;
  const retryDelaysMs = deps.retryDelaysMs ?? [5_000, 15_000];

  // Track usage for LRU disk eviction even when pull is skipped.
  imageLastUsedAt.set(image, now());

  const isRegistryImage = isConfiguredRegistryImage(image, registry);
  const immutable = isImmutableImageRef(image);
  const lastPulled = imageLastPulledAt.get(image);
  const isFresh =
    cacheTtlSecs > 0 && lastPulled !== undefined && now() - lastPulled < cacheTtlSecs * 1000;

  const canUseLocalCache =
    !isRegistryImage ||
    immutable ||
    policy === 'if-not-present' ||
    (policy === 'smart' && isFresh);

  if (canUseLocalCache) {
    try {
      await client.getImage(image).inspect();
      const reason = !isRegistryImage
        ? 'already exists locally'
        : immutable
          ? 'immutable digest already exists locally'
          : policy === 'if-not-present'
            ? 'present locally (policy: if-not-present)'
            : 'cached locally (fresh within pull TTL)';
      console.log(`[${runId}] Image ${image} ${reason} — skipping pull`);
      await log(runId, 'INFO', `Image ${image} ${reason}`);
      return;
    } catch {
      // Image not found locally (e.g. evicted externally) — fall through to pull
      imageLastPulledAt.delete(image);
    }
  }

  const waiterAbortCheck = isAborted ?? (() => false);

  // Coalesce concurrent pulls for the exact same image ref (singleflight).
  // IMPORTANT: keep the check-and-insert into inFlightPulls completely
  // synchronous (no await before inFlightPulls.set) so concurrent runs
  // arriving in the same tick coalesce instead of launching duplicate pulls.
  const existingPull = inFlightPulls.get(image);
  if (existingPull) {
    const waiters = inFlightWaiters.get(image);
    waiters?.add(waiterAbortCheck);
    console.log(`[${runId}] Joining in-flight pull for ${image}...`);
    void log(runId, 'INFO', `Waiting for in-flight image pull ${image}...`);
    try {
      await waitForPullOrAbort(existingPull, isAborted);
    } finally {
      waiters?.delete(waiterAbortCheck);
    }
    imageLastUsedAt.set(image, now());
    return;
  }

  const auth = getRegistryAuth(image);
  const pullOnce: (img: string) => Promise<void> =
    deps.pullOnceFn ??
    ((img: string) =>
      new Promise<void>((resolve, reject) => {
        const pullOpts = auth || {};
        void client.pull(
          img,
          pullOpts,
          (err: Error | null, stream: NodeJS.ReadableStream | undefined) => {
            if (err) {
              reject(err);
              return;
            }
            if (!stream) {
              reject(new Error('No stream returned from docker pull'));
              return;
            }

            followPull(client.modem as PullModem, stream).then(resolve, reject);
          }
        );
      }));

  const waiters = new Set<() => boolean>([waiterAbortCheck]);
  inFlightWaiters.set(image, waiters);
  const allWaitersAborted = (): boolean =>
    waiters.size === 0 || [...waiters].every((check) => check());

  // Transient pull failures are common during fleet scale-up cold pulls.
  // Two retries with backoff ride out registry/stream blips; permanent errors
  // (404, 401, ENOSPC) fail fast via isRetryablePullError.
  const pullPromise = (async () => {
    console.log(`[${runId}] Pulling image ${image}...`);
    await log(runId, 'INFO', `Pulling image ${image}...`);
    await pullWithRetries(() => pullOnce(image), {
      delaysMs: retryDelaysMs,
      isAborted: allWaitersAborted,
      shouldRetry: isRetryablePullError,
      sleep: deps.sleep,
      onRetry: async (attemptNo, err) => {
        console.warn(`[${runId}] Pull attempt ${String(attemptNo)} failed: ${err.message}`);
        await log(
          runId,
          'WARN',
          `Image pull attempt ${String(attemptNo)} failed (${err.message}); retrying...`
        );
      },
    });
    const ts = now();
    imageLastPulledAt.set(image, ts);
    imageLastUsedAt.set(image, ts);
    console.log(`[${runId}] Image ${image} pulled successfully`);
    await log(runId, 'INFO', `Image ${image} pulled successfully`);
  })();

  inFlightPulls.set(image, pullPromise);
  // Clean up tracking maps once the pull settles, and swallow unhandled
  // rejections if every waiter exited early via abort.
  void pullPromise
    .finally(() => {
      if (inFlightPulls.get(image) === pullPromise) {
        inFlightPulls.delete(image);
      }
      if (inFlightWaiters.get(image) === waiters) {
        inFlightWaiters.delete(image);
      }
    })
    .catch(() => undefined);

  try {
    await waitForPullOrAbort(pullPromise, isAborted);
  } finally {
    waiters.delete(waiterAbortCheck);
  }
}

/**
 * Best-effort background pre-warming of configured images (`PREWARM_IMAGES`)
 * on runner boot. Pulls sequentially to avoid saturating disk I/O at startup,
 * and shares the singleflight map with live runs so a run arriving mid-prewarm
 * seamlessly joins the download already in progress.
 */
export async function prewarmConfiguredImages(): Promise<void> {
  if (config.prewarmImages.length === 0) return;
  console.log(`[Prewarm] Pre-pulling ${String(config.prewarmImages.length)} configured image(s)...`);
  for (const image of config.prewarmImages) {
    try {
      await pullImageIfNeeded(image, 'prewarm', undefined, {
        log: async () => undefined,
      });
    } catch (err) {
      console.warn(`[Prewarm] Failed to pre-pull ${image}: ${(err as Error).message}`);
    }
  }
}

/**
 * Build Apify-compatible environment variables for a run.
 */
export function buildActorEnv(options: {
  runId: string;
  actorId: string;
  userId?: string;
  apiBaseUrl: string;
  token: string;
  defaultDatasetId: string;
  defaultKeyValueStoreId: string;
  defaultRequestQueueId: string;
  memoryMbytes?: number;
  timeoutSecs?: number;
  proxyPassword?: string | null;
  proxyHostname?: string | null;
  proxyPort?: number | null;
}): Record<string, string> {
  const {
    runId,
    actorId,
    userId,
    apiBaseUrl,
    token,
    defaultDatasetId,
    defaultKeyValueStoreId,
    defaultRequestQueueId,
    memoryMbytes = config.defaultMemoryMb,
    timeoutSecs = config.defaultTimeoutSecs,
  } = options;

  const timeoutAt = new Date(Date.now() + timeoutSecs * 1000).toISOString();
  const containerApiBaseUrl = translateLocalhostForContainer(apiBaseUrl);

  const env: Record<string, string> = {
    // Identity
    APIFY_ACTOR_ID: actorId,
    APIFY_ACTOR_RUN_ID: runId,
    APIFY_USER_ID: userId ?? 'anonymous',

    // API connection (rewritten on macOS so the actor container can reach back
    // to the host-running API; see translateLocalhostForContainer).
    APIFY_API_BASE_URL: containerApiBaseUrl,
    APIFY_TOKEN: token,
    APIFY_API_PUBLIC_BASE_URL: containerApiBaseUrl,

    // Storage IDs
    APIFY_DEFAULT_DATASET_ID: defaultDatasetId,
    APIFY_DEFAULT_KEY_VALUE_STORE_ID: defaultKeyValueStoreId,
    APIFY_DEFAULT_REQUEST_QUEUE_ID: defaultRequestQueueId,

    // Runtime flags
    APIFY_IS_AT_HOME: '1',
    APIFY_HEADLESS: '1',
    APIFY_MEMORY_MBYTES: String(memoryMbytes),
    APIFY_TIMEOUT_AT: timeoutAt,

    // Input key
    APIFY_INPUT_KEY: 'INPUT',

    // Container info
    APIFY_CONTAINER_PORT: '4321',
    APIFY_CONTAINER_URL: `http://run-${runId}:4321`,

    // Also set CRAWLEE_ variants for newer crawlers
    CRAWLEE_STORAGE_DIR: '/tmp/storage',
  };

  // Apify proxy env injection — only when non-null. An empty env var
  // routes the SDK through the present-path with a bad value (confusing
  // 401s); absent var activates the well-tested API fallback to
  // /v2/users/me. See proxy-resolver.ts for resolution semantics.
  if (options.proxyPassword) env.APIFY_PROXY_PASSWORD = options.proxyPassword;
  if (options.proxyHostname) env.APIFY_PROXY_HOSTNAME = options.proxyHostname;
  if (options.proxyPort) env.APIFY_PROXY_PORT = String(options.proxyPort);

  return env;
}

/**
 * Clean up Docker resources to free disk space.
 * Removes: stopped containers, dangling images, build cache — and, under
 * disk pressure, evicts least-recently-used unused registry image tags
 * until disk usage drops below the target watermark.
 */
export async function cleanupDocker(
  // Injectable seams for unit tests; production uses the module docker
  // client and the real disk probe.
  deps: {
    dockerClient?: Docker;
    getDiskUsageRatio?: () => number;
  } = {}
): Promise<void> {
  const client = deps.dockerClient ?? docker;
  const diskRatio = deps.getDiskUsageRatio ?? getDiskUsageRatio;
  try {
    // Remove stopped containers — ONLY ours. The label filter matches
    // listRunningContainers/stopRun; without it this swept every exited
    // container on the host (innocent bystanders on shared Docker hosts)
    // and widened the remove()-race window in executeRun.
    const containers = await client.listContainers({
      all: true,
      filters: { status: ['exited', 'dead'], label: ['crawlee-cloud.run-id'] },
    });
    for (const c of containers) {
      try {
        await client.getContainer(c.Id).remove();
      } catch {
        // ignore
      }
    }
    if (containers.length > 0) {
      console.log(`[Cleanup] Removed ${String(containers.length)} stopped container(s)`);
    }

    // Prune dangling images
    const pruneResult = await client.pruneImages({ filters: { dangling: { true: true } } });
    const reclaimedMb = Math.round((pruneResult.SpaceReclaimed || 0) / 1024 / 1024);
    if (reclaimedMb > 0) {
      console.log(`[Cleanup] Pruned dangling images: ${String(reclaimedMb)}MB freed`);
    }

    // Prune build cache
    await client.pruneBuilder();

    // Disk-pressure eviction of unused TAGGED registry images (LRU-ordered).
    // Evicts oldest / least-recently-used registry tags first and stops once
    // disk usage drops below the target watermark (diskEvictPct - 10%),
    // preserving hot actor images on disk so they don't incur 1-2 minute
    // multi-GB cold re-pulls on the very next run.
    const ratio = diskRatio();
    if (ratio * 100 >= config.diskEvictPct) {
      if (!config.imageRegistry) {
        console.warn(
          `[Cleanup] Disk ${String(Math.round(ratio * 100))}% full (>= ${String(config.diskEvictPct)}% eviction threshold) but no IMAGE_REGISTRY configured — skipping image eviction (locally built images cannot be re-pulled). Free disk space manually.`
        );
      } else {
        const prefix = `${config.imageRegistry.replace(/\/+$/, '')}/`;
        const targetPct = Math.max(0, config.diskEvictPct - 10);
        const images = await client.listImages();

        // Collect candidate registry tags and sort least-recently-used first.
        const candidates: Array<{ tag: string; size: number; lastUsedMs: number }> = [];
        for (const image of images) {
          const createdMs = (image.Created || 0) * 1000;
          for (const tag of image.RepoTags ?? []) {
            if (!tag.startsWith(prefix)) continue;
            candidates.push({
              tag,
              size: image.Size || 0,
              lastUsedMs: imageLastUsedAt.get(tag) ?? createdMs,
            });
          }
        }
        candidates.sort((a, b) => a.lastUsedMs - b.lastUsedMs);

        let evictedTags = 0;
        let evictedMb = 0;
        for (const candidate of candidates) {
          try {
            await client.getImage(candidate.tag).remove();
            imageLastPulledAt.delete(candidate.tag);
            imageLastUsedAt.delete(candidate.tag);
            evictedTags++;
            evictedMb += Math.round(candidate.size / 1024 / 1024);
            if (diskRatio() * 100 < targetPct) {
              break;
            }
          } catch {
            // In use, shared, or already gone — the daemon is the
            // authority; skip.
          }
        }
        console.log(
          `[Cleanup] Disk ${String(Math.round(ratio * 100))}% full (>= ${String(config.diskEvictPct)}% eviction threshold) — evicted ${String(evictedTags)} unused registry image tag(s): ~${String(evictedMb)}MB freed`
        );
      }
    }
  } catch (err) {
    console.error('[Cleanup] Error:', (err as Error).message);
  }
}

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/** Start periodic Docker cleanup (every 30 minutes) */
export function startPeriodicCleanup(): void {
  const intervalMs = 30 * 60 * 1000;
  console.log('[Cleanup] Starting periodic Docker cleanup (every 30m)');
  cleanupInterval = setInterval(() => {
    void cleanupDocker();
  }, intervalMs);
}

/** Stop periodic cleanup */
export function stopPeriodicCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

/**
 * Check Docker daemon connectivity.
 */
export async function checkDocker(): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * List all running Actor containers.
 */
export async function listRunningContainers(): Promise<Docker.ContainerInfo[]> {
  const containers = await docker.listContainers({
    filters: {
      label: ['crawlee-cloud.run-id'],
    },
  });
  return containers;
}

/**
 * Stop a specific run's container.
 *
 * Lists with `all: true`: without it, a container that exists but is not
 * yet running (created, start() pending — the abort-vs-start race) is
 * invisible and the abort is silently lost. Running containers get a
 * graceful stop (SIGTERM, 10s); non-running ones are force-removed —
 * stop() on a created container errors, and there is no process to let
 * exit gracefully anyway.
 */
export async function stopRun(runId: string): Promise<void> {
  const containers = await docker.listContainers({
    all: true,
    filters: {
      label: [`crawlee-cloud.run-id=${runId}`],
    },
  });

  for (const containerInfo of containers) {
    const container = docker.getContainer(containerInfo.Id);
    if (containerInfo.State === 'running') {
      await container.stop({ t: 10 });
      console.log(`Stopped container ${containerInfo.Id} for run ${runId}`);
    } else {
      await container.remove({ force: true });
      console.log(
        `Removed non-running container ${containerInfo.Id} (${containerInfo.State}) for run ${runId}`
      );
    }
  }
}

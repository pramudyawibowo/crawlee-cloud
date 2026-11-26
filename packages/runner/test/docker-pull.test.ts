/**
 * followPull, pullWithRetries & pullImageIfNeeded — unit tests.
 *
 * Covers:
 * - In-body daemon pull errors surfaced by followPull
 * - Retry backoff, abort short-circuit, and permanent-error fast-fail
 * - Singleflight deduplication for concurrent pulls of the same image
 * - Smart TTL freshness cache + Redis invalidation hook
 * - Immutable @sha256 digest skip & pull policies (smart / if-not-present / always)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Docker from 'dockerode';
import {
  followPull,
  pullWithRetries,
  pullImageIfNeeded,
  invalidateImagePullCache,
  resetImagePullState,
  isImmutableImageRef,
  isConfiguredRegistryImage,
  isRetryablePullError,
  type PullModem,
  type PullProgressEvent,
} from '../src/docker.js';

/**
 * Fake modem that replays frames through onProgress, then finishes the way
 * docker-modem does: onFinished(err) where err is ONLY ever a transport
 * error — in-body error frames still finish with err=null.
 */
function fakeModem(frames: PullProgressEvent[], transportErr: Error | null = null): PullModem {
  return {
    followProgress: (_stream, onFinished, onProgress) => {
      for (const frame of frames) onProgress?.(frame);
      onFinished(transportErr);
    },
  };
}

const stream = null as unknown as NodeJS.ReadableStream;

describe('followPull', () => {
  it('resolves on a clean pull (status frames only)', async () => {
    const modem = fakeModem([
      { status: 'Pulling from library/foo' },
      { status: 'Downloading' },
      { status: 'Pull complete' },
    ]);

    await expect(followPull(modem, stream)).resolves.toBeUndefined();
  });

  it('rejects when an in-body error frame arrives, even though onFinished reports success', async () => {
    const modem = fakeModem([
      { status: 'Downloading' },
      {
        error: 'write /var/lib/docker/tmp/GetImageBlob123: no space left on device',
        errorDetail: {
          message: 'write /var/lib/docker/tmp/GetImageBlob123: no space left on device',
        },
      },
    ]);

    await expect(followPull(modem, stream)).rejects.toThrow(/no space left on device/);
  });

  it('prefers errorDetail.message over the bare error string', async () => {
    const modem = fakeModem([
      { error: 'terse', errorDetail: { message: 'detailed daemon cause' } },
    ]);

    await expect(followPull(modem, stream)).rejects.toThrow(/detailed daemon cause/);
  });

  it('still rejects on transport-level stream errors (the one path the old code handled)', async () => {
    const modem = fakeModem([{ status: 'Downloading' }], new Error('socket hang up'));

    await expect(followPull(modem, stream)).rejects.toThrow(/socket hang up/);
  });

  it('transport error wins when both are present (it is the more fundamental failure)', async () => {
    const modem = fakeModem([{ error: 'in-body' }], new Error('socket hang up'));

    await expect(followPull(modem, stream)).rejects.toThrow(/socket hang up/);
  });
});

describe('pullWithRetries', () => {
  // Background (prod 2026-07-16): a fleet scale-up cold-pulls the same
  // multi-GB image on every new droplet at once; 4 pulls died on
  // transient mid-transfer errors and their runs failed permanently —
  // nothing upstream retries a run that died before its container
  // existed. Retrying the pull itself rides out the blip.
  const noSleep = () => Promise.resolve();

  it('returns on first success without retrying', async () => {
    const attempt = vi.fn().mockResolvedValue(undefined);

    await pullWithRetries(attempt, { delaysMs: [1, 1], sleep: noSleep });

    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries through transient failures and succeeds', async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error('unexpected EOF'))
      .mockRejectedValueOnce(new Error('registry 503'))
      .mockResolvedValueOnce(undefined);
    const onRetry = vi.fn();

    await pullWithRetries(attempt, { delaysMs: [1, 1], sleep: noSleep, onRetry });

    expect(attempt).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(
      1,
      1,
      expect.objectContaining({ message: 'unexpected EOF' })
    );
  });

  it('throws the LAST error once retries are exhausted', async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockRejectedValueOnce(new Error('final cause'));

    await expect(pullWithRetries(attempt, { delaysMs: [1, 1], sleep: noSleep })).rejects.toThrow(
      'final cause'
    );
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('does not swallow a permanent failure into infinite retries (attempts = delays + 1)', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('manifest unknown'));

    await expect(pullWithRetries(attempt, { delaysMs: [], sleep: noSleep })).rejects.toThrow(
      'manifest unknown'
    );
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('stops retrying once the run is aborted — no pinning the slot through the retry window', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('registry 503'));

    await expect(
      pullWithRetries(attempt, { delaysMs: [1, 1], sleep: noSleep, isAborted: () => true })
    ).rejects.toThrow('registry 503');

    expect(attempt).toHaveBeenCalledTimes(1); // no retry once aborted
  });

  it('fails fast without retrying when shouldRetry returns false', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('manifest unknown'));

    await expect(
      pullWithRetries(attempt, {
        delaysMs: [5_000, 15_000],
        sleep: noSleep,
        shouldRetry: isRetryablePullError,
      })
    ).rejects.toThrow('manifest unknown');

    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe('image pull helpers', () => {
  it('detects immutable digest references', () => {
    const sha256 = 'a'.repeat(64);
    expect(isImmutableImageRef(`ghcr.io/org/actor-foo@sha256:${sha256}`)).toBe(true);
    expect(isImmutableImageRef(`ghcr.io/org/actor-foo:latest@sha256:${sha256}`)).toBe(true);
    expect(isImmutableImageRef('ghcr.io/org/actor-foo:latest')).toBe(false);
    expect(isImmutableImageRef('ghcr.io/org/actor-foo:v1.2.3')).toBe(false);
  });

  it('matches configured registry by prefix boundary', () => {
    expect(isConfiguredRegistryImage('ghcr.io/org/actor-a:latest', 'ghcr.io/org')).toBe(true);
    expect(isConfiguredRegistryImage('ghcr.io/org/actor-a:latest', 'ghcr.io/org/')).toBe(true);
    expect(isConfiguredRegistryImage('ghcr.io/org-other/actor-a:latest', 'ghcr.io/org')).toBe(
      false
    );
    expect(isConfiguredRegistryImage('crawlee-cloud/actor-a:latest', '')).toBe(false);
  });

  it('classifies permanent vs transient pull errors', () => {
    expect(isRetryablePullError(new Error('manifest unknown'))).toBe(false);
    expect(isRetryablePullError(new Error('(HTTP code 404) not found'))).toBe(false);
    expect(isRetryablePullError(new Error('unauthorized: authentication required'))).toBe(false);
    expect(isRetryablePullError(new Error('write /var/lib/docker: no space left on device'))).toBe(
      false
    );
    expect(isRetryablePullError(new Error('unexpected EOF'))).toBe(true);
    expect(isRetryablePullError(new Error('socket hang up'))).toBe(true);
    expect(isRetryablePullError(new Error('HTTP 503 Service Unavailable'))).toBe(true);
  });
});

describe('pullImageIfNeeded optimizations', () => {
  const silentLog = async () => undefined;
  const noSleep = () => Promise.resolve();

  function fakeDockerInspect(presentImages: Set<string>) {
    return {
      getImage: vi.fn((img: string) => ({
        inspect: vi.fn(() =>
          presentImages.has(img)
            ? Promise.resolve({ Id: 'sha256:local' })
            : Promise.reject(new Error('404 not found'))
        ),
      })),
      pull: vi.fn(),
      modem: {},
    } as unknown as Pick<Docker, 'getImage' | 'pull' | 'modem'>;
  }

  beforeEach(() => {
    resetImagePullState();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('deduplicates concurrent pulls for the same image (singleflight)', async () => {
    const present = new Set<string>();
    const dockerClient = fakeDockerInspect(present);
    let releasePull!: () => void;
    const pullOnceFn = vi.fn(
      (img: string) =>
        new Promise<void>((resolve) => {
          releasePull = () => {
            present.add(img);
            resolve();
          };
        })
    );

    const img = 'ghcr.io/org/actor-heavy:latest';
    const deps = {
      dockerClient,
      imageRegistry: 'ghcr.io/org',
      policy: 'smart' as const,
      cacheTtlSecs: 300,
      log: silentLog,
      pullOnceFn,
      sleep: noSleep,
    };

    const p1 = pullImageIfNeeded(img, 'run-1', undefined, deps);
    const p2 = pullImageIfNeeded(img, 'run-2', undefined, deps);
    const p3 = pullImageIfNeeded(img, 'run-3', undefined, deps);

    // Give microtasks a tick so all three enter pullImageIfNeeded
    await Promise.resolve();
    releasePull();
    await Promise.all([p1, p2, p3]);

    expect(pullOnceFn).toHaveBeenCalledTimes(1);
  });

  it('skips remote pull within smart TTL cache and re-pulls after invalidation or TTL expiry', async () => {
    const present = new Set<string>();
    const dockerClient = fakeDockerInspect(present);
    let clock = 1_000_000;
    const pullOnceFn = vi.fn(async (img: string) => {
      present.add(img);
    });

    const img = 'ghcr.io/org/actor-fast:latest';
    const deps = {
      dockerClient,
      now: () => clock,
      imageRegistry: 'ghcr.io/org',
      policy: 'smart' as const,
      cacheTtlSecs: 300,
      log: silentLog,
      pullOnceFn,
      sleep: noSleep,
    };

    // 1st run: cold pull
    await pullImageIfNeeded(img, 'run-1', undefined, deps);
    expect(pullOnceFn).toHaveBeenCalledTimes(1);

    // 2nd run (60s later, within 300s TTL): cache hit, skips remote pull
    clock += 60_000;
    await pullImageIfNeeded(img, 'run-2', undefined, deps);
    expect(pullOnceFn).toHaveBeenCalledTimes(1);

    // Actor re-pushed -> Redis invalidates cache -> immediate re-pull
    invalidateImagePullCache(img);
    await pullImageIfNeeded(img, 'run-3', undefined, deps);
    expect(pullOnceFn).toHaveBeenCalledTimes(2);

    // Advance past TTL -> re-pulls
    clock += 301_000;
    await pullImageIfNeeded(img, 'run-4', undefined, deps);
    expect(pullOnceFn).toHaveBeenCalledTimes(3);
  });

  it('always skips pull for immutable @sha256 digest images when present locally', async () => {
    const img = `ghcr.io/org/actor-pinned@sha256:${'b'.repeat(64)}`;
    const dockerClient = fakeDockerInspect(new Set([img]));
    const pullOnceFn = vi.fn();

    await pullImageIfNeeded(img, 'run-1', undefined, {
      dockerClient,
      imageRegistry: 'ghcr.io/org',
      policy: 'always',
      cacheTtlSecs: 0,
      log: silentLog,
      pullOnceFn,
      sleep: noSleep,
    });

    expect(pullOnceFn).not.toHaveBeenCalled();
  });

  it('skips pull for registry images when policy is if-not-present and image is local', async () => {
    const img = 'ghcr.io/org/actor-cached:latest';
    const dockerClient = fakeDockerInspect(new Set([img]));
    const pullOnceFn = vi.fn();

    await pullImageIfNeeded(img, 'run-1', undefined, {
      dockerClient,
      imageRegistry: 'ghcr.io/org',
      policy: 'if-not-present',
      cacheTtlSecs: 0,
      log: silentLog,
      pullOnceFn,
      sleep: noSleep,
    });

    expect(pullOnceFn).not.toHaveBeenCalled();
  });
});

/**
 * Unit tests for the scaler's decision math.
 *
 * `calculateDesiredRunners` is the pure function at the heart of every
 * scale-up / scale-down decision. Bugs here translate directly to either
 * (a) over-provisioning runners (paying for VMs you don't need) or
 * (b) under-provisioning (queue pile-up, slow runs).
 *
 * The function has three regimes:
 *   - No demand → minRunners (the floor)
 *   - Low demand below threshold → stay flat (hysteresis, prevents flapping)
 *   - Real demand → ceil(demand / runsPerRunner), clamped to [min, max]
 */

import { describe, it, expect } from 'vitest';
import { calculateDesiredRunners, type QueueStats } from '../src/scaler/index.js';
import type { ScalerConfig } from '../src/scaler/types.js';

function makeConfig(overrides: Partial<ScalerConfig> = {}): ScalerConfig {
  return {
    enabled: true,
    provider: 'noop',
    minRunners: 1,
    maxRunners: 10,
    scaleUpThreshold: 5,
    idleTimeoutSecs: 600,
    pollIntervalSecs: 30,
    runsPerRunner: 2,
    runnerSize: 'unused',
    runnerRegion: 'unused',
    sshKeyId: 'unused',
    providerConfig: {},
    ...overrides,
  };
}

function stats(ready: number, running: number): QueueStats {
  return { ready, running, total: ready + running };
}

describe('calculateDesiredRunners', () => {
  describe('idle queue', () => {
    it('returns minRunners=0 when scale-to-zero is configured and queue is empty', () => {
      const desired = calculateDesiredRunners(stats(0, 0), 3, makeConfig({ minRunners: 0 }));
      expect(desired).toBe(0);
    });

    it('returns minRunners=1 when floor is 1 and queue is empty', () => {
      const desired = calculateDesiredRunners(stats(0, 0), 3, makeConfig({ minRunners: 1 }));
      expect(desired).toBe(1);
    });

    it('floor-protects even when current count is below min', () => {
      // Edge case: somehow we have 0 runners but min is 2 — must come back up
      const desired = calculateDesiredRunners(stats(0, 0), 0, makeConfig({ minRunners: 2 }));
      expect(desired).toBe(2);
    });
  });

  describe('hysteresis (low pressure)', () => {
    it('stays flat when ready <= threshold AND already at-or-above min', () => {
      // ready=3, threshold=5 → don't scale up just because there's some work
      const cfg = makeConfig({ scaleUpThreshold: 5, minRunners: 1 });
      const desired = calculateDesiredRunners(stats(3, 0), 1, cfg);
      expect(desired).toBe(1); // unchanged
    });

    it('does NOT block scale-up when below min, even if ready <= threshold', () => {
      // We have 0 runners, min is 2, ready is 1 (below threshold).
      // The min-floor must win — otherwise a brand-new system with min=2 would
      // never spawn its first runner because demand starts low.
      const cfg = makeConfig({ scaleUpThreshold: 5, minRunners: 2 });
      const desired = calculateDesiredRunners(stats(1, 0), 0, cfg);
      expect(desired).toBe(2);
    });

    it('scales up immediately once ready > threshold', () => {
      // 6 ready > threshold of 5 → math kicks in: ceil(6/2)=3
      const cfg = makeConfig({
        scaleUpThreshold: 5,
        runsPerRunner: 2,
        minRunners: 1,
        maxRunners: 10,
      });
      const desired = calculateDesiredRunners(stats(6, 0), 1, cfg);
      expect(desired).toBe(3);
    });
  });

  describe('scale-up math', () => {
    it('computes ceil(demand / runsPerRunner)', () => {
      const cfg = makeConfig({
        runsPerRunner: 3,
        scaleUpThreshold: 0,
        minRunners: 0,
        maxRunners: 100,
      });
      // 10 ready / 3 per runner = 3.33 → 4 runners
      expect(calculateDesiredRunners(stats(10, 0), 0, cfg)).toBe(4);
      // 9 / 3 = 3 exactly → 3 runners (no extra)
      expect(calculateDesiredRunners(stats(9, 0), 0, cfg)).toBe(3);
      // 1 / 3 = 0.33 → 1 runner (always round up)
      expect(calculateDesiredRunners(stats(1, 0), 0, cfg)).toBe(1);
    });

    it('counts RUNNING toward demand, not just READY', () => {
      // If we only counted READY, an in-flight run would let the scaler
      // tear down the runner that's currently executing it.
      const cfg = makeConfig({
        runsPerRunner: 1,
        scaleUpThreshold: 0,
        minRunners: 0,
        maxRunners: 10,
      });
      expect(calculateDesiredRunners(stats(0, 5), 5, cfg)).toBe(5);
    });

    it('clamps to maxRunners even under huge demand', () => {
      const cfg = makeConfig({
        runsPerRunner: 1,
        scaleUpThreshold: 0,
        minRunners: 0,
        maxRunners: 5,
      });
      expect(calculateDesiredRunners(stats(1000, 0), 0, cfg)).toBe(5);
    });
  });

  describe('scale-down math', () => {
    it('asks for fewer runners when demand drops below current capacity', () => {
      // Yesterday: 20 ready → 10 runners. Today: only 4 ready left.
      // ceil(4/2) = 2 → desired = 2, current = 10 → caller will scale down by 8.
      const cfg = makeConfig({
        runsPerRunner: 2,
        scaleUpThreshold: 0,
        minRunners: 0,
        maxRunners: 20,
      });
      expect(calculateDesiredRunners(stats(4, 0), 10, cfg)).toBe(2);
    });

    it('returns to the floor when the queue fully drains', () => {
      // This is the "all runs done" path that triggers eventual scale-down.
      const cfg = makeConfig({ minRunners: 1, maxRunners: 10 });
      expect(calculateDesiredRunners(stats(0, 0), 5, cfg)).toBe(1);
    });

    it('never returns below minRunners no matter how empty', () => {
      const cfg = makeConfig({ minRunners: 3 });
      expect(calculateDesiredRunners(stats(0, 0), 10, cfg)).toBe(3);
    });
  });
});

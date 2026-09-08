import { describe, it, expect, vi } from 'vitest';
import {
  writeRunMetrics,
  STATS_SAMPLE_INTERVAL_MS,
  type LogRedis,
  type LogRedisPipeline,
  type RunMetricSnapshot,
} from '../src/docker.js';

type PipelineCmd = [op: string, ...args: unknown[]];

function mockRedis(): { client: LogRedis; batches: PipelineCmd[][]; commands: PipelineCmd[] } {
  const batches: PipelineCmd[][] = [];
  const commands: PipelineCmd[] = [];

  const client: LogRedis = {
    pipeline(): LogRedisPipeline {
      const cmds: PipelineCmd[] = [];
      const p: LogRedisPipeline = {
        set: (key, value) => {
          cmds.push(['set', key, value]);
          commands.push(['set', key, value]);
        },
        rpush: (key, value) => {
          cmds.push(['rpush', key, value]);
          commands.push(['rpush', key, value]);
        },
        ltrim: (key, start, stop) => {
          cmds.push(['ltrim', key, start, stop]);
          commands.push(['ltrim', key, start, stop]);
        },
        expire: (key, seconds) => {
          cmds.push(['expire', key, seconds]);
          commands.push(['expire', key, seconds]);
        },
        publish: (channel, message) => {
          cmds.push(['publish', channel, message]);
          commands.push(['publish', channel, message]);
        },
        exec: async () => {
          batches.push(cmds);
          return cmds.map(() => [null, 1] as [Error | null, unknown]);
        },
      };
      return p;
    },
  };
  return { client, batches, commands };
}

describe('writeRunMetrics', () => {
  it('has 1 second real-time sample interval', () => {
    expect(STATS_SAMPLE_INTERVAL_MS).toBe(1000);
  });

  it('writes snapshot to Redis key, pushes to history, trims to 120, and publishes to channel', async () => {
    const { client, commands } = mockRedis();
    const metric: RunMetricSnapshot = {
      runId: 'run-123',
      timestamp: '2026-09-08T00:00:00.000Z',
      usedMb: 256,
      limitMb: 1024,
      percent: 25.0,
      peakMemoryMb: 300,
    };

    await writeRunMetrics(client, 'run-123', metric);

    const json = JSON.stringify(metric);
    expect(commands).toEqual([
      ['set', 'metrics:run-123', json],
      ['expire', 'metrics:run-123', 86400],
      ['rpush', 'metrics:history:run-123', json],
      ['ltrim', 'metrics:history:run-123', -120, -1],
      ['expire', 'metrics:history:run-123', 86400],
      ['publish', 'metrics:run-123', json],
    ]);
  });

  it('tolerates Redis errors without throwing (never kills the runner)', async () => {
    const brokenClient: LogRedis = {
      pipeline(): LogRedisPipeline {
        return {
          set: () => {},
          rpush: () => {},
          ltrim: () => {},
          expire: () => {},
          publish: () => {},
          exec: async () => {
            throw new Error('Redis connection lost');
          },
        };
      },
    };

    const metric: RunMetricSnapshot = {
      runId: 'run-err',
      timestamp: '2026-09-08T00:00:00.000Z',
      usedMb: 100,
      limitMb: 512,
      percent: 19.5,
      peakMemoryMb: 100,
    };

    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(writeRunMetrics(brokenClient, 'run-err', metric)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

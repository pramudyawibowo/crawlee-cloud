import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';

const TEST_USER = { id: 'test-user-id', email: 'test@example.com', role: 'user' };

vi.mock('../src/auth/middleware.js', () => ({
  authenticate: async (request: { user?: { id: string; email: string; role: string } }) => {
    request.user = { ...TEST_USER };
  },
}));

const mockQuery = vi.fn();
vi.mock('../src/db/index.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  getClient: vi.fn(),
}));

vi.mock('../src/storage/redis.js', () => ({
  redis: {
    get: vi.fn(),
    lrange: vi.fn(),
    duplicate: vi.fn(() => ({
      subscribe: vi.fn(),
      unsubscribe: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue('OK'),
      on: vi.fn(),
    })),
  },
}));

import { runsRoutes } from '../src/routes/runs.js';
import { redis } from '../src/storage/redis.js';

describe('Run Metrics Route (GET /actor-runs/:runId/metrics)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await runsRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(redis.get).mockReset();
    vi.mocked(redis.lrange).mockReset();
  });

  it('returns 404 when run is not found or inaccessible', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: '/actor-runs/nonexistent-run/metrics',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.type).toBe('record-not-found');
  });

  it('returns live metrics from Redis when available', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'run-1',
          actor_id: 'act-1',
          user_id: 'test-user-id',
          status: 'RUNNING',
          memory_mbytes: 1024,
          peak_memory_mb: 200,
        },
      ],
    });

    const currentMetric = {
      runId: 'run-1',
      timestamp: '2026-09-08T00:00:05.000Z',
      usedMb: 250,
      limitMb: 1024,
      percent: 24.4,
      peakMemoryMb: 250,
    };

    const historyPoint = {
      runId: 'run-1',
      timestamp: '2026-09-08T00:00:01.000Z',
      usedMb: 180,
      limitMb: 1024,
      percent: 17.6,
      peakMemoryMb: 180,
    };

    vi.mocked(redis.get).mockResolvedValueOnce(JSON.stringify(currentMetric));
    vi.mocked(redis.lrange).mockResolvedValueOnce([
      JSON.stringify(historyPoint),
      JSON.stringify(currentMetric),
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/actor-runs/run-1/metrics',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toEqual({
      runId: 'run-1',
      status: 'RUNNING',
      memoryLimitMb: 1024,
      peakMemoryMb: 250,
      current: currentMetric,
      history: [historyPoint, currentMetric],
    });
  });

  it('falls back to DB peak_memory_mb when Redis has no cached metrics', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'run-finished',
          actor_id: 'act-1',
          user_id: 'test-user-id',
          status: 'SUCCEEDED',
          memory_mbytes: 512,
          peak_memory_mb: 180,
        },
      ],
    });

    vi.mocked(redis.get).mockResolvedValueOnce(null);
    vi.mocked(redis.lrange).mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/actor-runs/run-finished/metrics',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toEqual({
      runId: 'run-finished',
      status: 'SUCCEEDED',
      memoryLimitMb: 512,
      peakMemoryMb: 180,
      current: null,
      history: [],
    });
  });
});

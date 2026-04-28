# v0.4.0 — Reliability & Operations Design

## Summary

Five features to make Crawlee Cloud production-grade: Prometheus metrics, enhanced health checks, graceful shutdown, run history retention, and database backup utilities.

## 1. Prometheus Metrics

Add `prom-client` to `packages/api`. Expose `GET /metrics` on the same Fastify server.

> **Auth note (post-v0.4.0):** `/metrics` was originally shipped unauthenticated. It is now gated behind `requireAdmin` to avoid leaking process internals and per-route counters publicly. Operators must configure their Prometheus scrape job with an admin-scoped JWT (preferred — O(1) verify) or admin API key (works, but each scrape triggers `bcrypt.compare` against every active key — see `packages/api/src/auth/middleware.ts`). Operators on a private network can opt out via `METRICS_PUBLIC=true`; in production this logs a startup warning. There is no equivalent flag for `/v2/scaler/status` — runner IPs and scaler config have no public use case.
>
> **Follow-up:** `validateApiKey` currently iterates all active API keys per request. For high-cadence Prometheus scrapes using API-key auth this is O(N) bcrypt per scrape. A small in-memory `Map<key, {userId, expiresAt}>` with a short TTL (~60s) would reduce this to O(1) without changing the security model. Not blocking, but worth doing before any deployment with >20 active API keys scraping `/metrics`.

**Metrics collected:**

| Metric                          | Type      | Labels                     |
| ------------------------------- | --------- | -------------------------- |
| `http_requests_total`           | Counter   | method, route, status_code |
| `http_request_duration_seconds` | Histogram | method, route              |
| `actor_runs_total`              | Counter   | status                     |
| `actor_runs_active`             | Gauge     | —                          |
| `webhook_deliveries_total`      | Counter   | status                     |
| `scheduler_active_jobs`         | Gauge     | —                          |
| `db_pool_active_connections`    | Gauge     | —                          |
| `db_pool_idle_connections`      | Gauge     | —                          |

Default Node.js metrics (GC, memory, event loop) via `collectDefaultMetrics()`.

HTTP metrics collected via Fastify `onRequest`/`onResponse` hooks.

## 2. Health Checks

Three endpoints, all unauthenticated:

- **`GET /health`** — Backward-compatible `{ status: 'ok', version }` (existing)
- **`GET /health/live`** — Liveness: always returns 200
- **`GET /health/ready`** — Readiness: checks DB, Redis, S3 with 3s timeout per check. Returns 200 or 503 with `{ status, checks: { db, redis, s3 }, schedulerJobs }`.

New file: `packages/api/src/health.ts`.

## 3. Graceful Shutdown

**API Server** (SIGTERM/SIGINT):

1. Stop scheduler (unregister all cron jobs)
2. `fastify.close()` (drain in-flight HTTP requests)
3. Close Redis connection
4. Close database pool
5. Exit 0

**Runner** (SIGTERM/SIGINT):

1. Set `shuttingDown = true` — stop polling for new runs
2. Wait for active runs to finish (tracked via `Set<string>`)
3. Stop webhook retry processor
4. Close Redis/database connections
5. Exit 0

`SHUTDOWN_TIMEOUT_SECS` default: 60. Force exit after timeout.

## 4. Run History Retention

CLI script: `scripts/cleanup-old-data.ts`

Deletes terminal runs older than `--retention-days` (default 90) plus associated storages (datasets, KV stores, request queues) from both DB and S3. Also cleans webhook deliveries older than `--webhook-retention-days` (default 30).

Features: `--dry-run` flag, batch processing (100/batch), summary output.

```bash
npx tsx scripts/cleanup-old-data.ts --retention-days 90 --dry-run
npx tsx scripts/cleanup-old-data.ts --retention-days 90
```

## 5. Backup & Restore

Three CLI scripts wrapping `pg_dump`/`pg_restore`:

- `scripts/backup-db.ts` — Create compressed custom-format dump
- `scripts/restore-db.ts` — Restore from dump with confirmation prompt
- `scripts/list-backups.ts` — List available backup files with sizes

```bash
npx tsx scripts/backup-db.ts --output ./backups/
npx tsx scripts/restore-db.ts ./backups/crawlee-cloud-backup-2026-02-25.dump
npx tsx scripts/list-backups.ts
```

## Decisions

- Metrics on same API server port (no separate metrics port)
- S3 included in readiness check
- Shutdown timeout default 60s
- Retention via CLI only (no built-in scheduler)
- Backup = pg_dump wrapper only (no S3 backup)

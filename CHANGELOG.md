# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.8.0] - 2026-05-01

### Breaking

- `GET /metrics` is now admin-only by default. Previously unauthenticated, the endpoint exposed process internals and per-route HTTP counters useful for fingerprinting a deployment. Self-hosted operators scraping `/metrics` with Prometheus must update their scrape config to send an admin JWT (or admin API key) in the `Authorization: Bearer ...` header. `/health`, `/health/live`, and `/health/ready` remain unauthenticated for k8s probes. Set `METRICS_PUBLIC=true` to opt out (see Added below).
- `GET /v2/scaler/status` is now admin-only with no opt-out — the response includes runner IPs, cloud provider, and scaler config that have no public use case.

### Added

- **Auto-scaling**: new `local-docker` scaler provider for development and small self-hosted setups; reaper sweeps dead runners; image registry support (GHCR, Docker Hub) so new runners pull actor images on demand instead of requiring a local build.
- **Build versioning**: actor versions and builds are tracked separately, with a partial unique index on `actor_versions(actor_id, build_tag)` to allow multiple builds per tag while keeping the active one unique.
- **Run pagination**: scale-aware, stable pagination for run listings — keyset-based, holds steady under high write volume.
- **CLI profiles**: `crc login --profile <name>` saves named credential sets; `crc profile list/use/rm` and `CRAWLEE_CLOUD_PROFILE=...` env override let you switch between local/staging/prod without re-logging-in.
- **CLI `crc info`**: shows active profile, API URL, server reachability, and authenticated user. Exits non-zero on failure — usable as a CI gate.
- **Actor default env vars and image** in `defaultRunOptions` — set per-actor defaults that apply to every run unless overridden at run time.
- **Dashboard pages**: Builds, Schedules, Webhooks, Request Queues, Runners, Key-Value Store browser, mobile nav, toast/dialog/confirm UI primitives.
- `METRICS_PUBLIC` env var (default `false`) — opt-in escape hatch for operators running Prometheus on a private network where the scrape job can't pass an `Authorization` header. When `METRICS_PUBLIC=true` and `NODE_ENV=production`, the API logs a startup warning. There is intentionally no equivalent flag for `/v2/scaler/status`.

### Changed

- Documentation moved from the website repo to `docs/` in this repo as the source of truth, with sync to the public site.
- Dashboard migrated to Tailwind v4 utility names (`bg-signal`, `text-fail`, ...) and a unified warm-orange `--signal` color across themes.
- ESLint: pedantic rules softened, real-bug rules kept strict.

### Fixed

- `apify-client` 404 contract: API responses now include `error.type='record-not-found'` so `catchNotFoundOrThrow` correctly falls through to `getOrCreate`.
- Runner API key is regenerated when bound to a stale user, fixing a 404-on-own-storage failure mode after admin changes.
- `PUT /v2/acts/:id` now persists `defaultRunOptions`, `maxRetries`, and `retryDelaySecs` correctly.
- Dataset items return type narrowed at the consumer rather than the helper, unblocking dashboard CI.
- Runner prefixes `actor-` when pulling from a configured registry, matching the build naming convention.

## [0.1.0] - 2025-12-14

### Added

#### Infrastructure (Sep 28)

- Docker Compose orchestration for PostgreSQL, Redis, and MinIO
- Separate dev and production configurations
- Dockerfiles for API, Runner, and Actor base images

#### API Server (Oct 5 - Oct 18)

- Fastify server with Apify-compatible REST API
- Dataset CRUD operations (`/v2/datasets`)
- Key-value store support (`/v2/key-value-stores`)
- Request queue with deduplication (`/v2/request-queues`)
- Actor management routes (`/v2/acts`)
- Run execution and status (`/v2/actor-runs`)
- JWT authentication system
- PostgreSQL integration for metadata
- Redis for distributed locking
- S3-compatible blob storage

#### Runner (Oct 26)

- Docker-based Actor execution
- Job queue polling from Redis
- Container lifecycle management
- Log streaming to API
- Resource limits and graceful shutdown

#### Dashboard (Nov 9 - Dec 6)

- Next.js application with App Router
- Actor listing and management UI
- Run execution with live logs
- Dataset browser
- Settings page
- Responsive sidebar navigation

#### CLI (Nov 22)

- `crawlee-cloud login` - Server authentication
- `crawlee-cloud push` - Push Actors to registry
- `crawlee-cloud run` - Execute Actors with input
- `crawlee-cloud logs` - Real-time log streaming

#### Documentation (Dec 13)

- Complete API reference
- CLI usage guide
- Dashboard overview
- Deployment instructions
- Runner configuration guide

### Features

- WebSocket streaming for real-time logs
- Request queue deduplication by `uniqueKey`
- Distributed locking for multiple workers
- Cloud-agnostic S3-compatible storage

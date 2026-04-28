# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Security

- **BREAKING:** `GET /metrics` is now admin-only by default. Previously unauthenticated, the endpoint exposed process internals and per-route HTTP counters useful for fingerprinting a deployment. Self-hosted operators scraping `/metrics` with Prometheus should update their scrape config to send an admin JWT (or admin API key) in the `Authorization: Bearer ...` header. `/health`, `/health/live`, and `/health/ready` remain unauthenticated for k8s probes.
- **BREAKING:** `GET /v2/scaler/status` is now admin-only with no opt-out — the response includes runner IPs, cloud provider, and scaler config that have no public use case.

### Added

- `METRICS_PUBLIC` env var (default `false`) — opt-in escape hatch for operators running Prometheus on a private network where the scrape job can't pass an `Authorization` header. When `METRICS_PUBLIC=true` and `NODE_ENV=production`, the API logs a startup warning. There is intentionally no equivalent flag for `/v2/scaler/status`.

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

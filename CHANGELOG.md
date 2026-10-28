# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Phase 1 core pipeline: `buildContext` (authorise, plan with typed needs, parallel fetch under per-source timeouts, scope re-filter, sanitise, priority budgeting, deterministic packet and hash, `context.*` audit events) in `packages/core`.
- Redaction of secrets (always) and personal data (`redaction.pii`, default on), ported from proba-memory.
- `policy.yaml` gains `restrictedTools` and `restrictedNeeds`; `loadTemplates` picks the highest template version per step type.
- Adapters: config-file `PolicySource` and `ToolCatalogSource`, `ApproximateTokenizer`, `SystemClock`, `RedisStreamAuditEmitter` (stream `proba.audit.events`), `LocalIdentityResolver` (refused when `NODE_ENV=production`), `FixedEmptySource` and `IdentityTaskSource`.
- `POST /v1/context/build` and `GET /v1/context/needs?stepType=` on `context-api`.
- Compose: password-protected Redis for the audit stream (`REDIS_PASSWORD` required).
- Ports: `PolicyGuard`, `AnalyticsSource.overview`, `IdentityCredentials.localIdentity`.
- Docs: complete DESIGN, `WALKTHROUGH_RAISE_BUDGET`, CONFIG for Phase 1; property tests (budget, scope, redaction, hash) with fast-check.
- Phase 0 scaffold: npm workspaces monorepo with `packages/core`, `packages/adapters` and `apps/context-api`.
- Core ports (conversation, task state, memory, audit history, analytics, policy, tool catalog, cache, tokenizer, audit emitter, clock, identity resolver).
- Config schema and YAML loader with clear validation errors, plus versioned templates for all eight step types.
- Deterministic packet hashing (`canonicalizeForHash`, `computePacketHash`).
- `context-api` Fastify service with `GET /health` on port 3500.
- Docker image, loopback-only compose file with required credentials, CI (lint, type check, unit tests, compose security, Docker build) and security workflows (gitleaks, npm audit report, CodeQL).

### Changed

- Production processes require `REDIS_URL` (host listed in `allowedDownstreamHosts`) and answer context requests with 503 `identity_unconfigured` until identity verification lands.

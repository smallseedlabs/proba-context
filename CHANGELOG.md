# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Phase 3 identity: `ActAsIdentityResolver` verifies Hub act-as assertions (`aud` contains `proba-context`; rejects expired, wrong issuer, `nbf`, forged and replayed `jti`), claims jtis in Redis (memory refused in production), and calls Hub `POST /v1/internal/authorize` (optional cache via `identity.authorizeCache`). `firebase_passthrough` verifies Firebase ID tokens when configured. Local identity only behind `NODE_ENV!=production` and `identity.allowLocal` / `CONTEXT_ALLOW_LOCAL_IDENTITY`.
- Admin `GET /v1/context/packets` and `GET /v1/context/packets/{id}` (Firebase allow-list, admin/viewer): viewers get 403; admins see the manifest only. Packet manifests stored in Redis (production) or memory (non-production).
- Per-caller and per-user rate limits (Redis in production), request size caps, strict CORS (none by default), `Cache-Control: no-store`, `auth.denied` audits on 401/403, scope-violation counter.
- Phase 2 HTTP source adapters for memory-api (`MemoryHttpSource`), audit-api events/traces (`AuditHttpSource`), audit-api analytics (`AnalyticsHttpSource`), and Hub task/conversation (`TaskStateHttpSource`, `ConversationHttpSource`): service JWT (`CONTEXT_SERVICE_PRIVATE_KEY_FILE`), forwarded `X-Act-As`, per-call SSRF allow-list, timeouts via the pipeline, bounded retries with jitter, circuit breaker, response size caps, zod contract validation → `source_error` gaps, and scope canary tests against copied upstream fixtures in `docs/contracts/upstream/{audit,memory,hub}/`.
- Hub adapters call `GET /v1/internal/goals/{goalId}/state` and `GET /v1/internal/threads/{threadId}/messages` when `HUB_BASE_URL` and the private key are set (replacing `IdentityTaskSource` / empty conversation on that path).
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

- Production processes require `REDIS_URL`, `HUB_ASSERTION_PUBLIC_KEY_FILE`, `HUB_BASE_URL` and `CONTEXT_SERVICE_PRIVATE_KEY_FILE` for `act_as_assertion`; in-memory rate/jti/packet adapters are refused.

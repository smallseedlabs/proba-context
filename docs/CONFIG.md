# Configuration

The service reads `CONTEXT_CONFIG_PATH` (default `config/context.config.yaml`) at start-up and refuses to start when the file is invalid; the error names the file and every offending key.

| Key | Meaning |
|-----|---------|
| `version` | Config version, copied into every packet as `configVersion`. |
| `identity.mode` | `act_as_assertion` (default) or `firebase_passthrough`. |
| `identity.allowLocal` | Accept local identities when `NODE_ENV!=production`. Ignored (and refused) in production. Also enabled by `CONTEXT_ALLOW_LOCAL_IDENTITY`. |
| `identity.authorizeCache` | `enabled` (default `false`) and `ttlSeconds` (must be positive when enabled). Caches Hub `POST /v1/internal/authorize` answers. |
| `sources.<kind>` | One entry per section kind (`policy`, `task`, `conversation`, `memory`, `audit_history`, `analytics`, `tools`): `enabled`, `timeoutMs` (a source that does not answer in time becomes a `source_timeout` gap), `tokenShare` (enabled shares add up to at most 1; a section other than policy, task and tools may use at most this share of the budget), and `cache` (see below). |
| `sources.<kind>.cache` | Per-source fetch cache: `enabled` (default `false`), `ttlSeconds` (default `0`; must be positive when enabled), `maxEntries`. Off by default; zero TTL means no caching. |
| `cacheStore` | Shared `ContextCache` adapter: `backend` (`memory` \| `redis`, default `memory`) and `allowMemoryInProduction` (default `false`). Redis uses `REDIS_URL` (password required in production; TLS via `rediss://` or `REDIS_TLS=true`). In-process cache is per-replica — set `allowMemoryInProduction: true` only when that caveat is acceptable. |
| `packetStore` | Postgres manifest retention: `retentionDays` (default `7`) and `purgeIntervalMinutes` (default `60`; `0` disables the in-process purge timer). Manifests never include item text. |
| `budget` | `defaultTokens`, `maxTokens` (a request's `budgetTokens` is capped by it), and `priorities` per section kind (lower is kept first). Policy, task and tools are never dropped whatever their priority; the others are trimmed in reverse priority order. |
| `allowedDownstreamHosts` | Hosts (`host` or `host:port`) the service may call (SSRF guard). The hosts of `REDIS_URL`, `DATABASE_URL`, `MEMORY_API_BASE_URL`, `AUDIT_API_BASE_URL` and `HUB_BASE_URL` must be listed (`redis:6379`, `postgres:5432`, `proba-memory:3420`, `proba-audit:3400`, `proba-hub:3300` in the shipped file). |
| `limits` | `maxNeedsPerRequest`, `maxItemsPerSource`, `maxItemChars`, `maxRequestBytes`. |
| `needs` | Hybrid needs loop (defaults applied when omitted): `maxRoundsPerStep` (default `2`), `extraTokenShare` (default `0.3`), and `kinds.<needKind>` with `source`, `maxItems`, `maxTokens`, and for `analytics_compare` `allowedWindows`. See [NEEDS](NEEDS.md). |
| `redaction.pii` | Default `true`. Redact email, phone, card, IBAN and SSN as well as secrets. Secrets are always redacted. |

Unknown keys are rejected. The config file's directory also holds everything else the service reads: `templates/`, `policy.yaml` and `tools.yaml`.

## Templates

`templates/<stepType>.v<N>.yaml`, one or more versions per step type, validated by the template schema. The service uses the highest `N` per step type and refuses a file whose name disagrees with its `stepType`. `sections` lists section kinds (once each) with `required` and an optional `maxItems`. A section the config switches off (`sources.<kind>.enabled: false`) is skipped; if it is `policy` or `task` and the template requires it, builds for that step fail. `templateVersion` is copied into every packet.

## Policy: `policy.yaml`

| Key | Meaning |
|-----|---------|
| `statements[]` | `id`, `text`, `appliesTo` (step types). Served as the `policy` section (system trust). |
| `restrictedTools[]` | `name`, `appliesTo`, `reason`. A tool listed here is never described to the brain in those steps, even if `tools.yaml` lists it for the step. Enforced in the tool catalog adapter and again in the pipeline. |
| `restrictedNeeds[]` | `kind` (`memory_search`, `analytics_compare`, `audit_trace`, `conversation_before`), `appliesTo`, `reason`. A need of that kind in those steps is refused with a `need_refused_by_policy` gap, and `GET /v1/context/needs` leaves it out. Both lists default to empty. |

## Tools: `tools.yaml`

`tools[]` with `name` (snake_case), `description`, `risk` (`low`, `medium`, `high`) and `appliesTo`. Served as the `tools` section: `text` is the description, `data` is `{ name, risk }`.

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3500` | Listen port. |
| `HOST` | `0.0.0.0` | Listen address inside the container; Compose publishes it on `127.0.0.1` only. |
| `LOG_LEVEL` | `info` | Log level. |
| `CONTEXT_CONFIG_PATH` | `config/context.config.yaml` | Config file. Templates, policy and tools are read from its directory. |
| `NODE_ENV` | unset | `production` (the container default) refuses local identities and in-memory rate/jti/packet stores; requires `REDIS_URL`, `DATABASE_URL` and assertion wiring. |
| `DATABASE_URL` | none | Postgres for packet manifests (`context_packets`). Host must be in `allowedDownstreamHosts`. Required when `NODE_ENV=production`. |
| `POSTGRES_PASSWORD` | none, required by Compose | Password of the Compose Postgres, also used in `DATABASE_URL`. |
| `REDIS_URL` | none | Redis for the audit stream, jti store, rate limits and (when `cacheStore.backend: redis`) the source cache. Host must be in `allowedDownstreamHosts`. Required when `NODE_ENV=production`. Production refuses a passwordless URL for the Redis cache. |
| `REDIS_TLS` | unset | When `true`/`1`, enable TLS for Redis even on `redis://` URLs. Prefer `rediss://`. |
| `REDIS_TLS_REJECT_UNAUTHORIZED` | unset (`1` behaviour) | Set to `0` only when a private CA is not yet wired (not for production). |
| `AUDIT_STREAM` | `proba.audit.events` | Stream name (the one the audit consumer reads). |
| `AUDIT_STREAM_MAXLEN` | `0` (no trimming) | Approximate `MAXLEN` for the stream. |
| `AUDIT_API_TOKEN`, `MEMORY_API_TOKEN` | none, required by Compose | Legacy compose placeholders; Phase-2 reads use the service JWT below. |
| `REDIS_PASSWORD` | none, required by Compose | Password of the Compose Redis, also used in `REDIS_URL`. |
| `MEMORY_API_BASE_URL` | none | Base URL of memory-api. With `AUDIT_API_BASE_URL` and `CONTEXT_SERVICE_PRIVATE_KEY_FILE`, wires Phase-2 HTTP memory. |
| `AUDIT_API_BASE_URL` | none | Base URL of audit-api. Wires audit history and analytics HTTP sources. |
| `HUB_BASE_URL` | none | Base URL of the Hub. Required for act-as identity (authorize) and for Hub task/conversation sources. |
| `HUB_ASSERTION_PUBLIC_KEY_FILE` | none | JWKS of Hub act-as assertion public keys. Required in production for `act_as_assertion`. Absolute path and `go-w` in production. |
| `CONTEXT_SERVICE_PRIVATE_KEY_FILE` | none | Ed25519 PEM private key the bridge uses to mint service JWTs (`iss=proba-context`, `sub=context-reader`, `aud` = target). Required with Hub/memory/audit URLs and for authorize. |
| `CONTEXT_SERVICE_KEY_ID` | `bridge-key-1` | `kid` written into the service JWT header. |
| `CONTEXT_ALLOW_LOCAL_IDENTITY` | unset | When truthy and `NODE_ENV!=production`, enables the local identity resolver (also `identity.allowLocal`). |
| `FIREBASE_PROJECT_ID` | none | Enables Firebase verification for `firebase_passthrough` and for admin packet routes. |
| `CONTEXT_API_ADMIN_EMAILS` | none | Comma-separated admin emails (Firebase allow-list). |
| `CONTEXT_API_ALLOWED_EMAILS` | none | Comma-separated viewer emails. |
| `CONTEXT_API_ALLOWED_EMAIL_DOMAINS` | none | Comma-separated viewer email domains. |
| `CONTEXT_API_CORS_ORIGINS` | none | Comma-separated allowed origins. Empty = CORS disabled (strict default). |
| `CONTEXT_RATE_LIMIT_MAX` | `60` | Max requests per caller and per user per window. |
| `CONTEXT_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window in milliseconds. |

Production refuses in-memory rate limiters, jti stores and packet stores. The in-process source cache is refused in production unless `cacheStore.allowMemoryInProduction` is true (each replica keeps its own copy). Every response carries `Cache-Control: no-store`. Send `SIGHUP` to reload `context.config.yaml`, templates, policy and tools without restarting; `cacheStore.backend` cannot change on reload (restart instead). The active `configVersion` is written into every packet manifest and exposed on `/metrics` and `/ready`.

## Worked example: turn on memory caching and read the effect

1. Edit `config/context.config.yaml`:

```yaml
sources:
  memory:
    enabled: true
    timeoutMs: 1500
    tokenShare: 0.15
    cache:
      enabled: true
      ttlSeconds: 30
      maxEntries: 1000
```

2. Restart the process, or send `SIGHUP` to the running `context-api` PID so it reloads the config (`configVersion` stays the same unless you bump `version`).

3. With caching still cold, run the benchmark:

```bash
node scripts/bench-context.mjs --url http://127.0.0.1:3500 --token "Bearer local:<userId>:seedbed:<goalId>:<threadId>" --rounds 40
```

(Use a Hub-minted act-as assertion in production.)

4. Run the same command again. The second run should show lower p50/p95 when memory is on the critical path, and `/metrics` should show a rising `context_cache_hits_total{source="memory"}` relative to `context_cache_misses_total`. Hit ratio = hits / (hits + misses). Packet manifests set `manifest.sources.memory.cacheHit: true` on hits. Audit events `context.cache_hit` / `context.cache_miss` carry counts only (never item text).

5. To clear entries for one goal or user (admin Firebase token):

```bash
curl -s -X POST http://127.0.0.1:3500/v1/cache/invalidate \
  -H "authorization: Bearer <firebase-admin-id-token>" \
  -H "content-type: application/json" \
  -d '{"workspaceId":"seedbed","goalId":"<goal-uuid>"}'
```

# Runbook

## Start

```bash
export AUDIT_API_TOKEN=... MEMORY_API_TOKEN=... REDIS_PASSWORD=... POSTGRES_PASSWORD=...
docker compose up --build -d
curl -s http://127.0.0.1:3500/health   # {"status":"ok","service":"context-api"}
curl -s http://127.0.0.1:3500/ready    # checks: config, cache, packetStore
```

Compose refuses to start until the secret variables are set. It starts Postgres (packet manifests), runs `migrate`, then `context-api` (production mode) and a password-protected Redis that is not published on the host.

Production mode requires `REDIS_URL`, `DATABASE_URL`, `HUB_ASSERTION_PUBLIC_KEY_FILE`, `HUB_BASE_URL` and `CONTEXT_SERVICE_PRIVATE_KEY_FILE` for `act_as_assertion`. To exercise the pipeline on a workstation without Hub keys, run outside production with local identity:

```bash
docker network create ctx
docker run -d --name ctx-redis --network ctx --network-alias redis redis:7-alpine redis-server --requirepass pw --save ""
docker run -d --name ctx-pg --network ctx --network-alias postgres \
  -e POSTGRES_USER=proba -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=proba_context postgres:16-alpine
docker run --rm --network ctx -e DATABASE_URL='postgresql://proba:pw@postgres:5432/proba_context' proba-context-migrate:local
docker run -d --name ctx-api --network ctx -p 127.0.0.1:3500:3500 \
  -e NODE_ENV=development -e CONTEXT_ALLOW_LOCAL_IDENTITY=true \
  -e REDIS_URL='redis://:pw@redis:6379' \
  -e DATABASE_URL='postgresql://proba:pw@postgres:5432/proba_context' \
  proba-context-api:local
```

## Stop

```bash
docker compose down
```

## Keys and rotation

| Key | Env | Who holds it |
|-----|-----|----------------|
| Hub act-as private | `HUB_ASSERTION_PRIVATE_KEY_FILE` (Hub only) | Hub mints assertions |
| Hub act-as public | `HUB_ASSERTION_PUBLIC_KEY_FILE` | Bridge (and other verifiers) |
| Bridge service private | `CONTEXT_SERVICE_PRIVATE_KEY_FILE` | Bridge mints `context-reader` JWTs |
| Bridge service public | `CONTEXT_SERVICE_PUBLIC_KEY_FILE` | Hub / audit-api / memory-api |

Rotation:

1. Generate a new Ed25519 pair; keep the old public key in the verifier JWKS/PEM set under a new `kid`.
2. Deploy verifiers with both keys; deploy the Hub/bridge with the new private key and `*_KEY_ID`.
3. After the old key's max assertion TTL (5 minutes act-as, 2 minutes service) has passed, drop the old public key.
4. Never commit private keys. Local umbrella `./up.sh --context` writes PEMs under `local/keys/` and paths into `local/.env` (gitignored). Production refuses locally generated keys when `NODE_ENV=production` if your deployment policy marks them as such — use vault/`*_FILE` mounts.

## Cache

- Default: every `sources.<kind>.cache.enabled` is `false`.
- Turn on memory caching: set `sources.memory.cache.enabled: true` and `ttlSeconds: 30`, then `SIGHUP` or restart. Prefer `cacheStore.backend: redis` in production.
- Invalidate: admin `POST /v1/cache/invalidate` with `userId` and/or `goalId` (audited as `context.cache_invalidated`).
- Metrics: `context_cache_hits_total`, `context_cache_misses_total`.

## Packet manifests

- Stored in Postgres `context_packets` (hash, ids, versions, manifest JSON). Never item text.
- Admin `GET /v1/context/packets?goalId=` and `GET /v1/context/packets/{id}` (audited `context.packet_viewed`).
- Retention: `packetStore.retentionDays` (default 7). Purge interval: `packetStore.purgeIntervalMinutes`.

## Metrics

`GET /metrics` (Prometheus text). When Firebase admin is configured the route requires an admin token; otherwise it is intended for the internal / loopback network (Compose binds `127.0.0.1`). Labels are source names, gap codes and section kinds only — never user or workspace ids.

Useful series: `context_source_requests_total`, `context_cache_hits_total`, `context_cache_misses_total`, `context_source_latency_ms`, `context_build_duration_ms`, `context_items_*_total`, `context_gaps_total`, `context_tokens_total`, `context_scope_violations_total`, `context_config_version_info`.

## Config reload

```bash
kill -HUP <context-api-pid>
```

Reloads `context.config.yaml`, templates, policy and tools. The active `configVersion` appears in every packet manifest, on `/ready`, and as `context_config_version_info` on `/metrics`. Changing `cacheStore.backend` requires a full restart.

## Checks

| Symptom | Look at |
|---------|---------|
| Container exits at start | `docker compose logs context-api`: an invalid config prints the file and each offending key. |
| `/health` does not answer | `docker compose ps` for the health state; confirm the port is `127.0.0.1:3500`. |
| `/ready` is 503 | Config failed to load, cache cannot `ping`, or Postgres packet store cannot `SELECT 1`. |
| Compose says a variable is required | Set the variable named in the message. |
| `REDIS_URL is required when NODE_ENV=production` or `host ... is not in allowedDownstreamHosts` | Set `REDIS_URL` / `DATABASE_URL`; add host:port to `allowedDownstreamHosts`. |
| `DATABASE_URL is required when NODE_ENV=production` | Point at Postgres with migrations applied (`docker compose` `migrate` service). |
| Redis cache refuses to start in production | `REDIS_URL` must include a password (`redis://:PASSWORD@host:6379` or `rediss://…`). |
| In-process cache refused in production | Set `cacheStore.backend: redis`, or set `cacheStore.allowMemoryInProduction: true` knowing each replica keeps its own copy. |
| 503 `audit_unavailable` | Redis is down or the password is wrong. Builds fail closed; they resume when Redis is back. |
| 503 `identity_unconfigured` | Outside production without `CONTEXT_ALLOW_LOCAL_IDENTITY` / assertion keys. In production, set assertion + Hub + service key env vars. |
| 401 `act_as_*` / `act_as_replayed` | Assertion missing, expired, wrong audience/issuer, or replayed `jti`. |
| 403 on `/v1/context/packets*` or `/v1/cache/invalidate` | Viewer role; admins only. Check `CONTEXT_API_ADMIN_EMAILS`. |
| 502 `required_source_failed` | The policy or task source failed or timed out; see the `context.source_fetched` events of the trace. |
| 422 `budget_exceeded_by_required` | Policy, task and tools need more tokens than the budget; raise `budgetTokens` (up to `budget.maxTokens`) or shorten the policy text. |
| A packet has `source_timeout` gaps | Raise `sources.<kind>.timeoutMs` or look at the source. |
| Cache hit ratio stays at 0 after enabling a source | Confirm `sources.<kind>.cache.enabled` and `ttlSeconds > 0`, reload with `SIGHUP` or restart, then re-run `scripts/bench-context.mjs` and read `/metrics`. |
| Scope violation counter rises | Another user's or workspace's item reached the bridge; check upstream filters and the `context.scope_violation` audit events. |

## Incident steps

1. Confirm blast radius: `/metrics` scope violations and gap rates; recent `context.build_failed` / `context.scope_violation` on the audit stream.
2. If a leak is suspected: disable the bridge at the Hub (`CONTEXT_BRIDGE_ENABLED=false` / unset URL), rotate assertion and service keys, invalidate cache for the affected user/goal.
3. Preserve manifests for the goal (`GET /v1/context/packets?goalId=`) — they have no item text but prove what was included/dropped.
4. Restore: fix upstream scope bug or config, re-enable bridge, watch `/ready` and build duration histograms.

## Benchmark

```bash
node scripts/bench-context.mjs --url http://127.0.0.1:3500 --token "$TOKEN" --rounds 40
```

See [CONFIG.md](CONFIG.md) for turning on memory caching with a 30s TTL and reading the hit ratio.

## Related

- [THREAT_MODEL.md](THREAT_MODEL.md)
- [WALKTHROUGHS.md](WALKTHROUGHS.md) — one numbered flow per step type
- [WALKTHROUGH_RAISE_BUDGET.md](WALKTHROUGH_RAISE_BUDGET.md) — deep dive on `propose_budget`

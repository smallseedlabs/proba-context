# Runbook

Extended as the service gains behaviour.

## Start

```bash
export AUDIT_API_TOKEN=... MEMORY_API_TOKEN=... REDIS_PASSWORD=...
docker compose up --build -d
curl -s http://127.0.0.1:3500/health   # {"status":"ok","service":"context-api"}
```

Compose refuses to start until the three variables are set. It starts `context-api` (production mode) and a password-protected Redis that is not published on the host.

Production mode requires `REDIS_URL`, `HUB_ASSERTION_PUBLIC_KEY_FILE`, `HUB_BASE_URL` and `CONTEXT_SERVICE_PRIVATE_KEY_FILE` for `act_as_assertion`. To exercise the pipeline on a workstation without Hub keys, run outside production with local identity:

```bash
docker network create ctx
docker run -d --name ctx-redis --network ctx --network-alias redis redis:7-alpine redis-server --requirepass pw --save ""
docker run -d --name ctx-api --network ctx -p 127.0.0.1:3500:3500 \
  -e NODE_ENV=development -e CONTEXT_ALLOW_LOCAL_IDENTITY=true \
  -e REDIS_URL='redis://:pw@redis:6379' proba-context-api:local
docker exec ctx-redis redis-cli -a pw xrange proba.audit.events - +   # the context.* events
```

## Stop

```bash
docker compose down
```

## Checks

| Symptom | Look at |
|---------|---------|
| Container exits at start | `docker compose logs context-api`: an invalid config prints the file and each offending key. |
| `/health` does not answer | `docker compose ps` for the health state; confirm the port is `127.0.0.1:3500`. |
| `/ready` is 503 | Config failed to load or the cache adapter cannot `ping` (Redis down / wrong password). |
| Compose says a variable is required | Set the variable named in the message. |
| `REDIS_URL is required when NODE_ENV=production` or `host ... is not in allowedDownstreamHosts` | Set `REDIS_URL`; add its host:port to `allowedDownstreamHosts`. |
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

## Config reload

```bash
kill -HUP <context-api-pid>
```

Reloads `context.config.yaml`, templates, policy and tools. The active `configVersion` appears in every packet manifest, on `/ready`, and as `context_config_version_info` on `/metrics`. Changing `cacheStore.backend` requires a full restart.

## Metrics

`GET /metrics` (Prometheus text). When Firebase admin is configured the route requires an admin token; otherwise it is intended for the internal / loopback network (Compose binds `127.0.0.1`). Labels are source names, gap codes and section kinds only — never user or workspace ids.

Useful series: `context_source_requests_total`, `context_cache_hits_total`, `context_cache_misses_total`, `context_source_latency_ms`, `context_build_duration_ms`, `context_items_*_total`, `context_gaps_total`, `context_tokens_total`, `context_scope_violations_total`, `context_config_version_info`.

## Benchmark

```bash
node scripts/bench-context.mjs --url http://127.0.0.1:3500 --token "$TOKEN" --rounds 40
```

See [CONFIG.md](CONFIG.md) for turning on memory caching with a 30s TTL and reading the hit ratio.

## To be added

- Dashboards and alerts from `/metrics`.
- Source timeout and gap-rate triage.

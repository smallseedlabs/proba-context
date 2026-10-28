# Runbook

Extended as the service gains behaviour.

## Start

```bash
export AUDIT_API_TOKEN=... MEMORY_API_TOKEN=... REDIS_PASSWORD=...
docker compose up --build -d
curl -s http://127.0.0.1:3500/health   # {"status":"ok","service":"context-api"}
```

Compose refuses to start until the three variables are set. It starts `context-api` (production mode) and a password-protected Redis that is not published on the host.

Production mode has no identity verification yet: `POST /v1/context/build` answers 503 `identity_unconfigured`. To exercise the pipeline in a container, run the image outside production on a private network:

```bash
docker network create ctx
docker run -d --name ctx-redis --network ctx --network-alias redis redis:7-alpine redis-server --requirepass pw --save ""
docker run -d --name ctx-api --network ctx -p 127.0.0.1:3500:3500 \
  -e NODE_ENV=development -e REDIS_URL='redis://:pw@redis:6379' proba-context-api:local
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
| Compose says a variable is required | Set the variable named in the message. |
| `REDIS_URL is required when NODE_ENV=production` or `host ... is not in allowedDownstreamHosts` | Set `REDIS_URL`; add its host:port to `allowedDownstreamHosts`. |
| 503 `audit_unavailable` | Redis is down or the password is wrong. Builds fail closed; they resume when Redis is back. |
| 503 `identity_unconfigured` | Expected in production until identity verification lands. |
| 502 `required_source_failed` | The policy or task source failed or timed out; see the `context.source_fetched` events of the trace. |
| 422 `budget_exceeded_by_required` | Policy, task and tools need more tokens than the budget; raise `budgetTokens` (up to `budget.maxTokens`) or shorten the policy text. |
| A packet has `source_timeout` gaps | Raise `sources.<kind>.timeoutMs` or look at the source. |

## To be added

- Dashboards and alerts.
- Source timeout and gap-rate triage.
- Config rollout and rollback.

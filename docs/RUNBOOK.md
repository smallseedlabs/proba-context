# Runbook

Skeleton; extended as the service gains behaviour.

## Start

```bash
export AUDIT_API_TOKEN=... MEMORY_API_TOKEN=...
docker compose up --build -d
curl -s http://127.0.0.1:3500/health   # {"status":"ok","service":"context-api"}
```

Compose refuses to start until both variables are set.

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

## To be added

- Dashboards and alerts.
- Source timeout and gap-rate triage.
- Config rollout and rollback.

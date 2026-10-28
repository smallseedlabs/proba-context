# proba-context

Context service for the Proba brain. For each brain step it builds one bounded, auditable **context packet** from the conversation, task state, memory, audit history, analytics, policy and tool catalog, and returns it with a deterministic `packetHash`.

The request and packet shapes (`ContextRequest`, `ContextPacket`) come from [`@smallseedlabs/proba-protocol`](https://github.com/smallseedlabs/proba-protocol), pinned at `v0.4.0`.

## Status

Phase 0 (scaffold). The service starts, validates its configuration and answers `GET /health`. The context endpoint, source adapters and packet assembly arrive in later phases (see [docs/DESIGN.md](docs/DESIGN.md)).

## Layout

| Path | Contents |
|------|----------|
| `packages/core` | `@smallseedlabs/proba-context-core`: ports, config schema and loader, templates schema, `packetHash`, protocol re-exports |
| `packages/adapters` | `@smallseedlabs/proba-context-adapters`: implementations of the ports (empty until Phase 1) |
| `apps/context-api` | Fastify service, port 3500 |
| `config/` | `context.config.yaml`, `policy.yaml`, `tools.yaml`, and `templates/` (one versioned file per step type) |
| `docs/` | [DESIGN](docs/DESIGN.md), [CONFIG](docs/CONFIG.md), [SCOPING](docs/SCOPING.md), [RUNBOOK](docs/RUNBOOK.md) |
| `scripts/` | `check-compose-security.mjs` |

## Run

Requires Node 20+ and, for the container, Docker with Compose.

```bash
npm install
npm run build
npm run watch:api          # http://127.0.0.1:3500, reads config/context.config.yaml
```

With Docker (Compose refuses to start until the credentials are set; the port is published on `127.0.0.1` only):

```bash
export AUDIT_API_TOKEN=... MEMORY_API_TOKEN=...
docker compose up --build -d
curl http://127.0.0.1:3500/health
```

```json
{ "status": "ok", "service": "context-api" }
```

## Endpoints

| Method | Path | Response |
|--------|------|----------|
| GET | `/health` | `{ "status": "ok", "service": "context-api" }` |

## Configuration

`CONTEXT_CONFIG_PATH` (default `config/context.config.yaml`) is validated at start-up; an invalid file stops the process and the error lists every offending key. The packet cache is off by default. See [docs/CONFIG.md](docs/CONFIG.md).

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3500` | Listen port |
| `HOST` | `0.0.0.0` | Listen address (inside the container) |
| `LOG_LEVEL` | `info` | Log level |
| `CONTEXT_CONFIG_PATH` | `config/context.config.yaml` | Config file |
| `AUDIT_API_TOKEN`, `MEMORY_API_TOKEN` | none | Downstream credentials, required by Compose |

## Develop

```bash
npm run lint         # ESLint, zero warnings
npm run typecheck    # sources and tests
npm test             # vitest
npm run build        # tsc -b
npm run compose:check
```

CI (`.github/workflows/ci.yml`) runs Lint, Type Check, Unit Tests, Compose security and Docker Build. `security.yml` runs gitleaks (MIT CLI), an `npm audit` report and CodeQL. See [SECURITY.md](SECURITY.md) for the audit policy and [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

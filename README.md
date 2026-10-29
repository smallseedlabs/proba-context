# proba-context

Context service for the Proba brain. For each brain step it builds one bounded, auditable **context packet** from the conversation, task state, memory, audit history, analytics, policy and tool catalog, and returns it with a deterministic `packetHash`.

The request and packet shapes (`ContextRequest`, `ContextPacket`) come from [`@smallseedlabs/proba-protocol`](https://github.com/smallseedlabs/proba-protocol), pinned at `v0.4.0`.

## Status

Context bridge through Phase 4. `POST /v1/context/build` verifies a Hub act-as assertion (or local identity on a workstation), authorises via Hub `POST /v1/internal/authorize`, and builds a packet from templates, typed needs (hybrid loop with round and extra-token caps), config-file policy/tools, and Phase-2 HTTP sources (memory, audit, analytics, Hub task/conversation) with redaction, scope filtering, budgeting, a deterministic `packetHash` and `context.*` audit events. `GET /v1/context/needs` lists allowed need kinds with limits. Admin `GET /v1/context/packets*` serve manifests only (Firebase allow-list). See [docs/DESIGN.md](docs/DESIGN.md), [docs/NEEDS.md](docs/NEEDS.md), [docs/SCOPING.md](docs/SCOPING.md) and [docs/CONFIG.md](docs/CONFIG.md).

## Layout

| Path | Contents |
|------|----------|
| `packages/core` | `@smallseedlabs/proba-context-core`: ports, config schema and loader, redaction, the build pipeline, `packetHash`, protocol re-exports |
| `packages/adapters` | `@smallseedlabs/proba-context-adapters`: config-file policy and tools, tokenizer, clock, Redis stream audit emitter, local identity |
| `apps/context-api` | Fastify service, port 3500 |
| `config/` | `context.config.yaml`, `policy.yaml`, `tools.yaml`, and `templates/` (one versioned file per step type) |
| `docs/` | [DESIGN](docs/DESIGN.md), [WALKTHROUGH_RAISE_BUDGET](docs/WALKTHROUGH_RAISE_BUDGET.md), [CONFIG](docs/CONFIG.md), [SCOPING](docs/SCOPING.md), [RUNBOOK](docs/RUNBOOK.md) |
| `scripts/` | `check-compose-security.mjs` |

## Run

Requires Node 20+ and, for the container, Docker with Compose.

```bash
npm install
npm run build
npm run watch:api          # http://127.0.0.1:3500, reads config/context.config.yaml
```

Outside production the service accepts a local identity (`Authorization: Bearer local:<userId>:<workspaceId>:<goalId>:<threadId>`) and prints audit events instead of writing them to Redis unless `REDIS_URL` is set.

With Docker (Compose refuses to start until the credentials are set; the port is published on `127.0.0.1` only):

```bash
export AUDIT_API_TOKEN=... MEMORY_API_TOKEN=... REDIS_PASSWORD=...
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
| POST | `/v1/context/build` | `ContextRequest` in, `ContextPacket` out |
| GET | `/v1/context/needs?stepType=` | Allowed need kinds with limits for that step |
| GET | `/v1/context/packets?goalId=` | Admin: packet manifests for a goal |
| GET | `/v1/context/packets/{id}` | Admin: one packet manifest |

## Configuration

`CONTEXT_CONFIG_PATH` (default `config/context.config.yaml`) is validated at start-up; an invalid file stops the process and the error lists every offending key. The packet cache is off by default. See [docs/CONFIG.md](docs/CONFIG.md).

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3500` | Listen port |
| `HOST` | `0.0.0.0` | Listen address (inside the container) |
| `LOG_LEVEL` | `info` | Log level |
| `CONTEXT_CONFIG_PATH` | `config/context.config.yaml` | Config file |
| `NODE_ENV` | unset (`production` in the container) | `production` refuses local identities and requires `REDIS_URL` |
| `REDIS_URL` | none | Redis for the audit stream `proba.audit.events` |
| `AUDIT_API_TOKEN`, `MEMORY_API_TOKEN`, `REDIS_PASSWORD` | none | Required by Compose |

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

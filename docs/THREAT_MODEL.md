# Threat model (proba-context)

Scope: the context bridge (`context-api`) that builds bounded, auditable context packets for the brain. It is read-only toward Hub, audit-api and memory-api, and writes only its own audit events plus packet manifests (never item text).

## Assets

| Asset | Why it matters |
|-------|----------------|
| Act-as assertions and service JWTs | Prove who the Hub is acting as and that the bridge is `context-reader`. |
| Packet contents (conversation, memory, analytics) | User and workspace data the brain may see. |
| Packet manifests in Postgres | Replay and admin review without re-fetching text. |
| Cache entries | Already-redacted source payloads keyed by workspace/user. |
| Config (policy, tools, templates) | Decides what the brain is told is allowed. |

## Actors

- **Hub** (intended caller): mints short-lived act-as assertions; calls `POST /v1/context/build`.
- **Admin (Firebase allow-list)**: reads manifests and invalidates cache.
- **Downstream services**: audit-api, memory-api, Hub internal reads — trust the bridge only with assertion + scope params.
- **Attacker on the network / misconfigured peer**: tries SSRF, cross-tenant reads, replay, or production-unsafe adapters.

## Trust boundaries

1. Inbound HTTP (Compose binds `127.0.0.1`) → identity resolver → pipeline.
2. Bridge → downstream HTTP (host allow-list, service JWT, `X-Act-As`, `actorId`/`workspaceId` must match).
3. Bridge → Redis (password required in production for cache) and Postgres (packet store).
4. Config files on disk → validated at start and on `SIGHUP`.

## Threats and controls

| Threat | Control |
|--------|---------|
| Cross-user / cross-workspace leak into a packet | Upstream scoped queries + in-bridge re-filter; `context.scope_violation` + metric. |
| SSRF via crafted URLs | `allowedDownstreamHosts`; refuse non-listed hosts at start and on each client. |
| Replay of act-as assertion | Short TTL, `jti` claim store (Redis in production; memory refused). |
| Forged Hub or bridge identity | Ed25519 verify; production requires key files; absolute paths; refuse local identity in production. |
| Secrets / PII in packets or audits | Redactor on sanitise; manifests and `context.*` audits carry counts/ids only, never item text. |
| Instruction injection via user/memory text | User/memory/external text only in typed item fields; only policy/tools may carry bridge-authored instructions. |
| Unsafe production adapters | Refuse in-memory rate limiter, jti store, packet store; refuse passwordless Redis cache; require Postgres `DATABASE_URL` for manifests. |
| Empty admin allow-lists with Firebase admin routes | Admin authorizer denies when allow-lists are empty / email not listed. |
| Cache serving another user's data | Cache keys embed workspaceId and userId; invalidate by user/goal is admin-only and audited. |
| Retention of stale manifests | `packetStore.retentionDays` + purge interval / migrate CLI. |

## Out of scope

Brain decisions, tool execution, limbs, portal UI, and write paths on Hub/audit/memory. Those enforce their own authz; the bridge states the allowed tool set and never executes tools.

## Incident starting points

See [RUNBOOK.md](RUNBOOK.md): `/ready` checks, `/metrics` (`context_scope_violations_total`, gap codes, build duration), Redis stream `proba.audit.events` for `context.*`, and admin `GET /v1/context/packets/{id}` for manifests only.

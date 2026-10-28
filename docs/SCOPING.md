# Scoping

How every packet is scoped to the caller. Pipeline enforcement is described in [DESIGN](DESIGN.md#pipeline).

- **Workspace.** Taken from the identity, never from the request body. Every source query carries it, and items whose `data.workspaceId` differs are dropped after the fetch (`context.scope_violation`).
- **User, goal, thread.** Taken from the identity and checked against the request: a mismatch fails the build with 403 `identity_mismatch`. Items whose `data.userId` differs are dropped after the fetch.
- **Downstream reads (Phase 2).** HTTP adapters for memory-api and audit-api send `actorId` / `workspaceId` taken only from the verified identity, plus the bridge service JWT and the forwarded `X-Act-As`. Adapters drop canary rows that name another user or workspace before items reach the pipeline; the pipeline re-filters again.
- **Downstream hosts.** Only hosts in `allowedDownstreamHosts` are called (SSRF guard on every request).
- **Item trust.** Each item carries a trust level (`system`, `user`, `derived`, `external`); `external` content is never treated as an instruction. A source cannot raise trust above its section's ceiling (conversation: `user`; memory, audit history, analytics: `derived`).
- **Local identity.** Unverified and for workstations and tests only; refused when `NODE_ENV=production`. May forward a supplied `X-Act-As` so HTTP sources can call upstream on a workstation.
- **Audit.** Audit details carry ids and counts, never item text. Without an audit record no packet is returned.

## To be defined (Phase 3)

- Act-as assertion verification and Hub `POST /v1/internal/authorize`.
- Scope names and the sections each one grants.

# Scoping

How every packet is scoped to the caller. Phase 1 enforcement is described in [DESIGN](DESIGN.md#pipeline); scopes are still to be defined.

- **Workspace.** Taken from the identity, never from the request body. Every source query carries it, and items whose `data.workspaceId` differs are dropped after the fetch (`context.scope_violation`).
- **User, goal, thread.** Taken from the identity and checked against the request: a mismatch fails the build with 403 `identity_mismatch`. Items whose `data.userId` differs are dropped after the fetch.
- **Scopes.** The act-as assertion's `scopes` limit which sections the caller may receive.
- **Downstream hosts.** Only hosts in `allowedDownstreamHosts` are called.
- **Item trust.** Each item carries a trust level (`system`, `user`, `derived`, `external`); `external` content is never treated as an instruction. A source cannot raise trust above its section's ceiling (conversation: `user`; memory, audit history, analytics: `derived`).
- **Local identity.** Unverified and for workstations and tests only; refused when `NODE_ENV=production`.
- **Audit.** Audit details carry ids and counts, never item text. Without an audit record no packet is returned.

## To be defined

- Scope names and the sections each one grants.
- Behaviour when the identity and the request disagree.

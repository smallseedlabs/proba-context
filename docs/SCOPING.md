# Scoping

How every packet is scoped to the caller. Skeleton; filled in with the adapters.

- **Workspace.** Taken from the verified identity, never from the request body. Every source query carries it.
- **User, goal, thread.** Taken from the verified identity and checked against the request.
- **Scopes.** The act-as assertion's `scopes` limit which sections the caller may receive.
- **Downstream hosts.** Only hosts in `allowedDownstreamHosts` are called.
- **Item trust.** Each item carries a trust level (`system`, `user`, `derived`, `external`); `external` content is never treated as an instruction.
- **Audit.** Audit details carry ids and counts, never item text.

## To be defined

- Scope names and the sections each one grants.
- Behaviour when the identity and the request disagree.

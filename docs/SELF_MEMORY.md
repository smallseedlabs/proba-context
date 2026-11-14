# Bootstrap self memory in the packet

Proba's self memory (who Proba is, how it behaves, what its limbs do) lives in proba-memory: the versioned seed
`bootstrap/proba-self.json` is upserted into memory-api's reserved system workspace on start and served read-only at `GET /v1/self`.

How it reaches the brain:

1. When `MEMORY_API_BASE_URL` is wired, `createHttpSources` adds `SelfMemoryHttpSource`
   (`packages/adapters/src/sources/selfMemoryHttpSource.ts`). It calls `GET /v1/self` with the bridge token and the caller's
   `X-Act-As` assertion (`actorId` / `workspaceId` from the verified identity, like every memory read) and caches the answer in-process
   for 60 s, because it is the same for everybody.
2. The runtime wraps the config policy source in `SelfAwarePolicySource` (`packages/adapters/src/policy/selfAwarePolicy.ts`): the
   policy section is the self memory first, then the `policy.yaml` statements. Items are `self.<key>`, `sourceRef.source`
   `proba-self`, trust `system`, score 1, no workspace or user in `data`.
3. Policy is tier 0, priority 0 and never dropped for budget, so the self memory is always the first thing in the packet.
   It costs roughly 1.7k tokens of the required budget with the shipped seed.
4. If memory-api is down or slow (400 ms), the packet carries the policy statements only and a warning is logged; policy stays
   build-critical as before.

No protocol change: the existing `policy` section kind is used. The gateway recognises the items by `sourceRef.source === 'proba-self'`
and puts them first in the model's system text.

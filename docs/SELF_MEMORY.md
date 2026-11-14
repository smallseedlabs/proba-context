# Bootstrap self memory in the packet

Proba's self memory (who Proba is, how it behaves, what its limbs do) lives in proba-memory: the versioned seed
`bootstrap/proba-self.json` is upserted into memory-api's reserved system workspace on start and served read-only at `GET /v1/self`.

How it reaches the brain:

1. When `MEMORY_API_BASE_URL` is wired, `createHttpSources` adds `SelfMemoryHttpSource`
   (`packages/adapters/src/sources/selfMemoryHttpSource.ts`). It calls `GET /v1/self` with the bridge token and the caller's
   `X-Act-As` assertion (`actorId` / `workspaceId` from the verified identity, like every memory read) and caches the answer in-process
   for 60 s, because it is the same for everybody.
2. The seed has one always-on **core** (`tier: core`, authored per version, ~300 tokens or fewer) and tagged **detail** entries
   (`tier: detail`, tags `step:`, `tool:`, `need:`, `goal:`, `topic:`).
3. **Core:** the runtime wraps the config policy source in `SelfAwarePolicySource` (`packages/adapters/src/policy/selfAwarePolicy.ts`):
   the policy section is the core first, then the `policy.yaml` statements. The item is `self.00-core`, `sourceRef.source` `proba-self`,
   trust `system`, score 1, text exactly the stored core content (byte-identical for every run of a version), no workspace or user.
   Policy is tier 0, priority 0 and never dropped for budget.
4. **Detail:** the runtime wraps the memory source in `SelfAwareMemorySource` (`packages/adapters/src/sources/selfAwareMemory.ts`), which
   adds the detail entries to the memory section's base recall (never to a `memory_search` need). Before the budget step,
   `scoreSelfDetails` (`packages/core/src/pipeline/selfDetail.ts`) keeps an entry only when its tags match the run with weight >= 2
   (operator's own words in the latest user messages count 2; the step type, the goal state from the task section and the tools
   offered for the step count 1) and gives it a score of 0.3 + 0.1 x weight. The existing ranking then places it against the
   user's memories inside the memory section's item limit and token share, so it can be dropped. Templates without a memory section
   (`handle_approval`, `launch_campaign`) carry the core only. Missing landing page / post copy are not in the Hub goal state:
   `goal:no_campaign` stands in for them, and the gateway's run brief states their exact presence.
5. If memory-api is down or slow (400 ms), the packet carries the policy statements and the user's memories only and a warning is
   logged; policy stays build-critical as before.

No protocol change: the existing `policy` section kind is used. The gateway recognises the items by `sourceRef.source === 'proba-self'`
and puts the core first in the model's system text.

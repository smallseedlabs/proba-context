# Hybrid needs

After the first (template) packet for a step, the brain may ask for more context through typed **needs**. There is no free-form query, SQL or URL: only the four registered kinds below. Each kind has a zod schema in `@smallseedlabs/proba-protocol`, hard limits and a source mapping in `config/context.config.yaml` (`needs.kinds`), and a `NeedHandler` in `packages/core`.

## Loop

1. Hub / brain calls `POST /v1/context/build` without `needs` → template packet (round 0).
2. Brain calls again with the same `stepId` and a `needs` list → needs round 1: the bridge extends the prior packet with the new items, re-runs budgeting (base budget + `needs.extraTokenShare`, default 30%), and audits each need.
3. A second needs call is round 2. A third is refused (`need_out_of_limits`) and the prior packet is returned with refusal gaps.
4. `GET /v1/context/needs?stepType=` lists the kinds policy allows for that step, with limits, so the brain prompt only mentions valid ones.

Defaults: `needs.maxRoundsPerStep: 2`, `needs.extraTokenShare: 0.3`. Round state is kept in Redis (production) or memory (workstation) keyed by workspace, user, goal and step.

## Need kinds

| Kind | Source | Hard limits (shipped) | Notes |
|------|--------|------------------------|-------|
| `memory_search` | `memory` | `maxItems` 20, `maxTokens` 1500; protocol `limit` ≤ 20 (default 5) | `{ kind, query, limit }` |
| `analytics_compare` | `analytics` | `maxItems` 10, `maxTokens` 1000; windows `1d`/`7d`/`14d`/`30d` | `{ kind, campaignIds, metric, window }`. `90d` is refused. |
| `audit_trace` | `audit_history` | `maxItems` 100, `maxTokens` 2000 | `{ kind, traceId }`. Restricted outside review/explain steps. A result that is only out of scope is refused. |
| `conversation_before` | `conversation` | `maxItems` 50, `maxTokens` 2000; protocol `limit` ≤ 50 (default 20) | `{ kind, cursor, limit }` |

Policy may further forbid a kind for a step via `restrictedNeeds` in `policy.yaml`. A disabled source refuses every need that maps to it.

## Refusals

A refused need never reaches a source (except the post-fetch scope case for `audit_trace`). The packet carries a gap and `context.need_refused` is audited:

| Gap code | When |
|----------|------|
| `need_refused_by_policy` | `restrictedNeeds`, source off, or need result entirely out of scope |
| `need_out_of_limits` | Over `maxNeedsPerRequest`, kind `maxItems`, disallowed analytics window, round cap, or budget above the extra share |

Gaps include a `reason` and a `suggestedQuestion`. Served needs emit `context.need_requested` and appear in the fetch/`source_fetched` trail.

## Example exchange

```http
GET /v1/context/needs?stepType=propose_budget
Authorization: Bearer <act-as assertion>
```

```json
{
  "stepType": "propose_budget",
  "allowedNeeds": [
    { "kind": "memory_search", "source": "memory", "maxItems": 20, "maxTokens": 1500 },
    {
      "kind": "analytics_compare",
      "source": "analytics",
      "maxItems": 10,
      "maxTokens": 1000,
      "allowedWindows": ["1d", "7d", "14d", "30d"]
    },
    { "kind": "conversation_before", "source": "conversation", "maxItems": 50, "maxTokens": 2000 }
  ],
  "maxNeedsPerRequest": 20,
  "maxRoundsPerStep": 2,
  "extraTokenShare": 0.3
}
```

Template build (no needs), then one extra need:

```json
{
  "traceId": "550e8400-e29b-41d4-a716-446655440000",
  "workspaceId": "seedbed",
  "userId": "660e8400-e29b-41d4-a716-446655440001",
  "goalId": "770e8400-e29b-41d4-a716-446655440002",
  "threadId": "880e8400-e29b-41d4-a716-446655440003",
  "stepId": "step-propose-budget-1",
  "stepType": "propose_budget",
  "needs": [
    {
      "kind": "analytics_compare",
      "campaignIds": ["770e8400-e29b-41d4-a716-446655440002"],
      "metric": "spend",
      "window": "7d"
    }
  ]
}
```

If the brain asks `window: "90d"`, the need is refused with `need_out_of_limits` and a suggested question listing the allowed windows; the prior packet content is kept.

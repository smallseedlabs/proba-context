# Design

proba-context builds the context the brain reasons over: one bounded, auditable **context packet** per step.
This document is a skeleton that later phases fill in.

## Purpose

Given a `ContextRequest` (trace, workspace, user, goal, thread, step, step type, optional typed needs and budget), return a `ContextPacket`:
sections of citable items, the gaps that could not be filled, and a manifest of what each source returned, kept and dropped. Both types come from `@smallseedlabs/proba-protocol` (v0.4.0).

## Architecture

- `packages/core`: ports (interfaces), config schema and loader, templates, `packetHash`. No network I/O.
- `packages/adapters`: implementations of the ports (conversation, task state, memory, audit history, analytics, policy, tool catalog, cache, tokenizer, audit emitter, identity). Empty until Phase 1.
- `apps/context-api`: HTTP surface. Phase 0 serves `GET /health` only.

## Request flow (target)

1. Resolve identity (act-as assertion or Firebase passthrough, per `identity.mode`).
2. Select the template for the step type (`config/templates/<stepType>.v<N>.yaml`).
3. Fetch from the sources in parallel, each under its `timeoutMs`; a source that fails or times out becomes a gap.
4. Fit items to the token budget by section priority and `tokenShare`.
5. Compute `packetHash` over the canonical JSON of the packet without its hash.
6. Emit audit events (ids and counts only, never item text) and return the packet.

## Ports

`ConversationSource`, `TaskStateSource`, `MemorySource`, `AuditHistorySource`, `AnalyticsSource`, `PolicySource`, `ToolCatalogSource`, `ContextCache`, `Tokenizer`, `AuditEmitter`, `Clock`, `IdentityResolver`.

## Packet hash

`computePacketHash` is SHA-256 (hex) of canonical JSON: keys sorted recursively, `undefined` omitted, no whitespace, array order kept.

## Phases

| Phase | Scope |
|-------|-------|
| 0 | Scaffold: monorepo, ports, config, templates, hash, health endpoint, CI, container |
| 1 | Adapters for the sources, identity and audit emission |
| 2 | Packet assembly, budgeting, the context endpoint |
| 3 | Typed needs, optional cache |

## Open questions

- To be filled in as the phases land.

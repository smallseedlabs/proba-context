# Upstream context-reader contracts

Copied fixtures from:

- `proba-audit/docs/contracts/context-reader/` → `audit/`
- `proba-memory/docs/contracts/context-reader/` → `memory/`
- `proba-hub/docs/contracts/context-reader/` → `hub/` (plus `ASSERTIONS_AND_INTERNAL_READS.md` from Hub docs)

Phase-2 adapter contract tests load these files. Refresh them when the upstream contracts change; do not invent alternate shapes.

`POST /v1/internal/authorize` is documented under `hub/` for reference; the bridge calls it in Phase 3 (identity), not Phase 2.

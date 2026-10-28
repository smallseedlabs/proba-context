import { canonicalizeForHash } from '../hash/packetHash.js';
import type { Tokenizer } from '../ports/index.js';
import type { ContextItem, SectionKind } from '../protocol.js';
import { ContextBuildError } from './errors.js';
import { REQUIRED_SECTIONS } from './sections.js';

export type DropReason =
  | 'scope_violation'
  | 'invalid_item'
  | 'policy_forbidden_tool'
  | 'duplicate'
  | 'section_limit'
  | 'source_share'
  | 'budget';

export interface Candidate {
  kind: SectionKind;
  item: ContextItem;
  tokens: number;
}

export interface Dropped {
  kind: SectionKind;
  itemId: string;
  reason: DropReason;
}

export interface BudgetInput {
  candidates: Candidate[];
  tiers: Record<SectionKind, number>;
  /** Config priority of each section, to order sections inside a tier. */
  priorities: Record<SectionKind, number>;
  /** Most items per section. */
  maxItems: ReadonlyMap<SectionKind, number>;
  /** Token share of each section (0 to 1); applied to every section except policy, task and tools. */
  shares: Record<SectionKind, number>;
  budgetTokens: number;
}

export interface BudgetResult {
  kept: Candidate[];
  dropped: Dropped[];
  /** Tokens of policy, task and tools. */
  requiredTokens: number;
}

/** Tokens an item takes in the packet: its canonical JSON, which is what the packet carries. */
export function itemTokens(tokenizer: Tokenizer, item: ContextItem): number {
  return tokenizer.count(canonicalizeForHash(item));
}

function rank(input: BudgetInput) {
  return (a: Candidate, b: Candidate): number =>
    input.tiers[a.kind] - input.tiers[b.kind] ||
    input.priorities[a.kind] - input.priorities[b.kind] ||
    (b.item.score ?? 0) - (a.item.score ?? 0) ||
    (a.item.observedAt < b.item.observedAt ? 1 : a.item.observedAt > b.item.observedAt ? -1 : 0) ||
    (a.item.itemId < b.item.itemId ? -1 : a.item.itemId > b.item.itemId ? 1 : 0) ||
    (a.item.sourceRef.id < b.item.sourceRef.id ? -1 : a.item.sourceRef.id > b.item.sourceRef.id ? 1 : 0);
}

/**
 * Step 6. Order: tier (policy, task, tools first), then score, then recency. Then, in this order:
 *
 * 1. drop duplicates by `sourceRef` (the better-ranked copy stays);
 * 2. cap each section at its item limit and, except for policy, task and tools, at its token share;
 * 3. fail if policy, task and tools alone exceed the budget;
 * 4. trim from the bottom of the ranking (analytics first, conversation last) until the packet fits.
 *
 * Policy, task and tools are never dropped for budget reasons. The result is a pure function of its input.
 */
export function applyBudget(input: BudgetInput): BudgetResult {
  const ordered = [...input.candidates].sort(rank(input));
  const dropped: Dropped[] = [];
  const drop = (c: Candidate, reason: DropReason): void => {
    dropped.push({ kind: c.kind, itemId: c.item.itemId, reason });
  };

  const seen = new Set<string>();
  const unique: Candidate[] = [];
  for (const c of ordered) {
    const key = `${c.item.sourceRef.source}\u0000${c.item.sourceRef.id}`;
    if (seen.has(key)) drop(c, 'duplicate');
    else {
      seen.add(key);
      unique.push(c);
    }
  }

  const perSection = new Map<SectionKind, { count: number; tokens: number }>();
  const capped: Candidate[] = [];
  for (const c of unique) {
    const used = perSection.get(c.kind) ?? { count: 0, tokens: 0 };
    perSection.set(c.kind, used);
    if (used.count >= (input.maxItems.get(c.kind) ?? Infinity)) {
      drop(c, 'section_limit');
      continue;
    }
    if (!REQUIRED_SECTIONS.has(c.kind) && used.tokens + c.tokens > Math.floor(input.budgetTokens * input.shares[c.kind])) {
      drop(c, 'source_share');
      continue;
    }
    used.count += 1;
    used.tokens += c.tokens;
    capped.push(c);
  }

  const required = capped.filter((c) => REQUIRED_SECTIONS.has(c.kind));
  const optional = capped.filter((c) => !REQUIRED_SECTIONS.has(c.kind));
  const requiredTokens = required.reduce((sum, c) => sum + c.tokens, 0);
  if (requiredTokens > input.budgetTokens) {
    throw new ContextBuildError(
      'budget_exceeded_by_required',
      `Policy, task and tools need ${requiredTokens} tokens but the budget is ${input.budgetTokens}.`
    );
  }

  let total = requiredTokens + optional.reduce((sum, c) => sum + c.tokens, 0);
  while (total > input.budgetTokens && optional.length > 0) {
    const last = optional.pop() as Candidate;
    total -= last.tokens;
    drop(last, 'budget');
  }
  return { kept: [...required, ...optional], dropped, requiredTokens };
}

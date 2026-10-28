import { SOURCE_NAMES, type ContextConfig } from '../config/index.js';
import type { ItemTrust, SectionKind } from '../protocol.js';

/** Sections that are never dropped: policy, task and tools. */
export const REQUIRED_SECTIONS: ReadonlySet<SectionKind> = new Set<SectionKind>(['policy', 'task', 'tools']);

/** Trust order, most trusted first. A source may lower an item's trust but never raise it above the section's ceiling. */
const TRUST_ORDER: readonly ItemTrust[] = ['system', 'user', 'derived', 'external'];

const TRUST_CEILING: Record<SectionKind, ItemTrust> = {
  policy: 'system',
  task: 'system',
  tools: 'system',
  conversation: 'user',
  memory: 'derived',
  audit_history: 'derived',
  analytics: 'derived',
};

export function clampTrust(kind: SectionKind, declared: ItemTrust): ItemTrust {
  const ceiling = TRUST_ORDER.indexOf(TRUST_CEILING[kind]);
  const actual = TRUST_ORDER.indexOf(declared);
  return TRUST_ORDER[Math.max(ceiling, actual)] ?? 'external';
}

/**
 * Tier of each section in the packet: 0 for policy, task and tools (never dropped), then 1, 2, ... for the
 * other sections in the order of `budget.priorities` (conversation first, analytics last in the shipped config).
 * Lower tiers are kept first; the highest tier is trimmed first.
 */
export function sectionTiers(config: ContextConfig): Record<SectionKind, number> {
  const rest = SOURCE_NAMES.filter((kind) => !REQUIRED_SECTIONS.has(kind)).sort(
    (a, b) => config.budget.priorities[a] - config.budget.priorities[b] || SOURCE_NAMES.indexOf(a) - SOURCE_NAMES.indexOf(b)
  );
  const tiers = {} as Record<SectionKind, number>;
  for (const kind of SOURCE_NAMES) tiers[kind] = REQUIRED_SECTIONS.has(kind) ? 0 : rest.indexOf(kind) + 1;
  return tiers;
}

/** Sections in packet order: by tier, then by configured priority. */
export function orderedSections(config: ContextConfig): SectionKind[] {
  const tiers = sectionTiers(config);
  return [...SOURCE_NAMES].sort(
    (a, b) =>
      tiers[a] - tiers[b] ||
      config.budget.priorities[a] - config.budget.priorities[b] ||
      SOURCE_NAMES.indexOf(a) - SOURCE_NAMES.indexOf(b)
  );
}

/**
 * Relevance of Proba's self detail entries to one build. The always-on core rides in the policy section; detail entries (each limb's
 * notes, where inputs come from, metrics, iteration guidance) arrive as memory-section candidates with tags, and this step keeps
 * only those whose tags match the run, scoring them so the existing ranking and the memory section's token share decide the rest.
 *
 * Signals (all from data this build already has; no protocol change):
 *   - command type: `step:<stepType>`;
 *   - goal state (task section): `goal:no_campaign` | `goal:has_campaign`, `goal:awaiting_approval`;
 *   - tools offered for the step (tools section): `tool:<name>`, plus the gateway verb a context tool stands for;
 *   - tools asked for and inputs named in the operator's latest messages (conversation section): `tool:`, `need:`, `topic:`.
 * Missing landing page / post copy are not in the Hub goal state; a goal without a campaign stands in for them, and the gateway's
 * run brief states their exact presence.
 */
import type { ContextItem, ContextRequest } from '../protocol.js';

/** `sourceRef.source` of every self memory item (core and detail). */
export const SELF_MEMORY_SOURCE = 'proba-self';

export function isSelfDetail(item: ContextItem): boolean {
  if (item.sourceRef.source !== SELF_MEMORY_SOURCE) return false;
  const data = item.data as { tier?: unknown } | undefined;
  return data?.tier === 'detail';
}

/** Context-api tool names (tools.yaml) -> the self tags they stand for. */
const CONTEXT_TOOL_TAGS: Readonly<Record<string, readonly string[]>> = {
  launch_campaign: ['tool:ads.create_campaign', 'topic:launch'],
  propose_budget: ['topic:budget'],
};

/** Words in the operator's own messages -> tags. Matched case-insensitively on word boundaries. */
const WORD_TAGS: ReadonlyArray<[RegExp, readonly string[]]> = [
  [/\b(research|audience|competitors?|subreddits?|market)\b/i, ['tool:research.gather', 'topic:research']],
  [/\b(landing|url|website|web ?page|link)\b/i, ['need:landing_url', 'topic:landing']],
  [/\b(copy|headlines?|creative|ad text|wording|post text)\b/i, ['need:creative', 'topic:creative']],
  [/\b(launch|go live|create (a |the )?campaign|start (a |the )?campaign)\b/i, ['tool:ads.create_campaign', 'topic:launch']],
  [/\b(pause|stop)\b/i, ['tool:ads.pause_campaign']],
  [/\b(resume|restart|unpause)\b/i, ['tool:ads.resume_campaign']],
  [/\b(budget|spend|cost|cap)\b/i, ['topic:budget']],
  [/\b(metrics?|performance|results?|ctr|cpc|cpa|clicks?|impressions?|conversions?|analytics|report)\b/i, ['need:metrics', 'topic:metrics']],
];

/** Weight of a matched tag: the operator's own words count double; context signals count once. */
const DIRECT = 2;
const CONTEXT = 1;
/** A detail entry needs at least this much evidence to be offered to the budget. */
export const SELF_DETAIL_MIN_WEIGHT = 2;

export interface SelfDetailInputs {
  request: Pick<ContextRequest, 'stepType'>;
  task: readonly ContextItem[];
  tools: readonly ContextItem[];
  conversation: readonly ContextItem[];
}

export function selfDetailSignals(input: SelfDetailInputs): Map<string, number> {
  const signals = new Map<string, number>();
  const add = (tag: string, weight: number) => signals.set(tag, Math.max(signals.get(tag) ?? 0, weight));
  add(`step:${input.request.stepType}`, CONTEXT);
  for (const t of input.task) {
    const data = (t.data ?? {}) as { campaignIds?: unknown; approvals?: unknown };
    if (Array.isArray(data.campaignIds)) add(data.campaignIds.length > 0 ? 'goal:has_campaign' : 'goal:no_campaign', CONTEXT);
    if (Array.isArray(data.approvals) && data.approvals.some((a) => (a as { status?: unknown })?.status === 'pending')) {
      add('goal:awaiting_approval', CONTEXT);
    }
  }
  for (const t of input.tools) {
    const name = (t.data as { name?: unknown } | undefined)?.name;
    if (typeof name !== 'string') continue;
    add(`tool:${name}`, CONTEXT);
    for (const tag of CONTEXT_TOOL_TAGS[name] ?? []) add(tag, CONTEXT);
  }
  // The operator's latest messages (user trust only: the brain's own words do not ask for anything).
  const userText = [...input.conversation]
    .filter((c) => c.trust === 'user' && typeof c.text === 'string')
    .sort((a, b) => (a.observedAt < b.observedAt ? 1 : -1))
    .slice(0, 2)
    .map((c) => c.text as string)
    .join('\n');
  for (const [re, tags] of WORD_TAGS) if (re.test(userText)) for (const tag of tags) add(tag, DIRECT);
  return signals;
}

/** Weight of the evidence that a detail entry matters to this run (0 when nothing matches). */
export function selfDetailWeight(item: ContextItem, signals: ReadonlyMap<string, number>): number {
  const tags = (item.data as { tags?: unknown } | undefined)?.tags;
  if (!Array.isArray(tags)) return 0;
  return tags.reduce<number>((sum, tag) => sum + (typeof tag === 'string' ? (signals.get(tag) ?? 0) : 0), 0);
}

/**
 * Keep the relevant detail entries, scored for the existing ranking (more evidence ranks higher, still within the memory
 * section's share and item limit), and drop the rest. Items that are not self details pass through untouched.
 */
export function scoreSelfDetails(items: readonly ContextItem[], signals: ReadonlyMap<string, number>): { kept: ContextItem[]; irrelevant: number } {
  const kept: ContextItem[] = [];
  let irrelevant = 0;
  for (const item of items) {
    if (!isSelfDetail(item)) {
      kept.push(item);
      continue;
    }
    const weight = selfDetailWeight(item, signals);
    if (weight < SELF_DETAIL_MIN_WEIGHT) {
      irrelevant += 1;
      continue;
    }
    kept.push({ ...item, score: Math.min(0.95, 0.3 + 0.1 * weight) });
  }
  return { kept, irrelevant };
}

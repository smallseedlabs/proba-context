import { describe, expect, it } from 'vitest';
import type { ContextItem } from '../protocol.js';
import { buildContext } from './buildContext.js';
import { OBSERVED_AT, harness, identity, item, request, requiredItems } from './__fixtures__/fixtures.js';
import { scoreSelfDetails, selfDetailSignals } from './selfDetail.js';

const detail = (key: string, tags: string[], text = `Proba guidance (${key}): notes.`): ContextItem => ({
  itemId: `self.${key}`,
  sourceRef: { source: 'proba-self', id: key },
  trust: 'system',
  text,
  score: 0,
  observedAt: OBSERVED_AT,
  data: { selfVersion: 'v3', key, memoryId: `00000000-0000-4000-8000-0000000000${key.slice(0, 2)}`, tier: 'detail', tags },
});
const core: ContextItem = {
  itemId: 'self.00-core',
  sourceRef: { source: 'proba-self', id: '00-core' },
  trust: 'system',
  text: 'You are Proba. When an action is blocked, say why and what would unblock it.',
  score: 1,
  observedAt: OBSERVED_AT,
  data: { selfVersion: 'v3', key: '00-core', memoryId: '00000000-0000-4000-8000-000000000000', tier: 'core' },
};
const userSays = (text: string): ContextItem => item('hub.thread', { trust: 'user', text });
const task = (data: Record<string, unknown>): ContextItem => ({
  itemId: 'task.goal',
  sourceRef: { source: 'hub.task', id: 'goal' },
  trust: 'system',
  data: { status: 'active', ...data },
  observedAt: OBSERVED_AT,
});
const DETAILS = [
  detail('10-limb-research', ['tool:research.gather', 'topic:research', 'goal:no_campaign', 'step:plan_goal']),
  detail('13-limb-manage', ['tool:ads.pause_campaign', 'goal:has_campaign', 'step:review_performance']),
  detail('21-input-creative', ['need:creative', 'topic:creative', 'goal:no_campaign']),
  detail('30-analytics', ['need:metrics', 'goal:has_campaign', 'step:review_performance']),
];

describe('self detail relevance signals', () => {
  it('derives step, goal state, offered tools and what the operator asked for', () => {
    const s = selfDetailSignals({
      request: { stepType: 'interpret_message' },
      task: [task({ campaignIds: [], approvals: [{ status: 'pending' }] })],
      tools: [{ ...core, itemId: 'tool.launch_campaign', data: { name: 'launch_campaign' } }],
      conversation: [userSays('Can you research my audience? Also how is the ad copy?')],
    });
    expect(s.get('step:interpret_message')).toBe(1);
    expect(s.get('goal:no_campaign')).toBe(1);
    expect(s.get('goal:awaiting_approval')).toBe(1);
    expect(s.get('tool:ads.create_campaign')).toBe(1);
    expect(s.get('tool:research.gather')).toBe(2);
    expect(s.get('need:creative')).toBe(2);
    expect(s.has('need:metrics')).toBe(false);
  });

  it("ignores the brain's own messages", () => {
    const s = selfDetailSignals({ request: { stepType: 'clarify' }, task: [], tools: [], conversation: [item('hub.thread', { trust: 'derived', text: 'I will research metrics.' })] });
    expect(s.has('tool:research.gather')).toBe(false);
  });

  it('keeps only entries with enough evidence and scores stronger matches higher', () => {
    const signals = new Map([['tool:research.gather', 2], ['topic:research', 2], ['goal:no_campaign', 1], ['step:plan_goal', 1]]);
    const { kept, irrelevant } = scoreSelfDetails([core, ...DETAILS], signals);
    expect(kept.map((i) => i.itemId)).toEqual(['self.00-core', 'self.10-limb-research']);
    expect(irrelevant).toBe(3);
    expect(kept[1].score).toBeCloseTo(0.9);
  });
});

describe('buildContext: self core plus relevant detail', () => {
  it('plan_goal with no campaign and a research question: research detail in memory, metrics and campaign management left out', async () => {
    const h = harness();
    requiredItems(h.sources);
    h.sources.items('policy', [core]);
    h.sources.items('task', [task({ campaignIds: [], approvals: [] })]);
    h.sources.items('conversation', [userSays('Can you research my audience on Reddit first?')]);
    h.sources.items('memory', [item('proba-memory', { text: 'The operator prefers short headlines.', score: 0.6 }), ...DETAILS]);
    const packet = await buildContext(h.deps, request({ stepType: 'plan_goal' }), identity());
    const policy = packet.sections.find((s) => s.kind === 'policy');
    expect(policy?.items[0]?.itemId).toBe('self.00-core');
    const memoryIds = packet.sections.find((s) => s.kind === 'memory')?.items.map((i) => i.itemId) ?? [];
    expect(memoryIds).toContain('self.10-limb-research');
    expect(memoryIds).not.toContain('self.30-analytics');
    expect(memoryIds).not.toContain('self.13-limb-manage');
  });

  it('review_performance on a live campaign: analytics and campaign-management detail, not the launch inputs', async () => {
    const h = harness();
    requiredItems(h.sources);
    h.sources.items('policy', [core]);
    h.sources.items('task', [task({ campaignIds: ['c1'], approvals: [] })]);
    h.sources.items('conversation', [userSays('How are the results this week?')]);
    h.sources.items('memory', DETAILS);
    const packet = await buildContext(h.deps, request({ stepType: 'review_performance' }), identity());
    const memoryIds = packet.sections.find((s) => s.kind === 'memory')?.items.map((i) => i.itemId) ?? [];
    expect(memoryIds).toContain('self.30-analytics');
    expect(memoryIds).toContain('self.13-limb-manage');
    expect(memoryIds).not.toContain('self.21-input-creative');
    expect(memoryIds).not.toContain('self.10-limb-research');
  });

  it('detail entries are dropped for budget; the core never is', async () => {
    const h = harness();
    requiredItems(h.sources);
    h.sources.items('policy', [core]);
    h.sources.items('task', [task({ campaignIds: [], approvals: [] })]);
    h.sources.items('conversation', [userSays('Research my audience and check the ad copy please.')]);
    const big = (key: string, tags: string[]) => detail(key, tags, `Proba guidance (${key}): ${'x'.repeat(1500)}`);
    h.sources.items('memory', [big('10-limb-research', ['tool:research.gather', 'topic:research']), big('21-input-creative', ['need:creative', 'topic:creative'])]);
    const packet = await buildContext(h.deps, request({ stepType: 'plan_goal', budgetTokens: 1200 }), identity());
    expect(packet.sections.find((s) => s.kind === 'policy')?.items[0]?.itemId).toBe('self.00-core');
    const memoryIds = packet.sections.find((s) => s.kind === 'memory')?.items.map((i) => i.itemId) ?? [];
    expect(memoryIds.filter((id) => id.startsWith('self.')).length).toBeLessThan(2);
  });
});

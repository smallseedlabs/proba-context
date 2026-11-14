import { describe, expect, it } from 'vitest';
import { validateContextPacket } from '../protocol.js';
import type { ContextItem } from '../protocol.js';
import { buildContext } from './buildContext.js';
import { OBSERVED_AT, harness, identity, item, request, requiredItems } from './__fixtures__/fixtures.js';

/** Proba's bootstrap self memory arrives as policy items from `proba-self` (score 1, one timestamp): see SelfAwarePolicySource. */
const self = (key: string, text: string): ContextItem => ({
  itemId: `self.${key}`,
  sourceRef: { source: 'proba-self', id: key },
  trust: 'system',
  text,
  score: 1,
  observedAt: OBSERVED_AT,
  data: { selfVersion: 'v1', key, memoryId: `00000000-0000-4000-8000-0000000000${key.slice(0, 2)}` },
});

describe('buildContext: bootstrap self memory', () => {
  it('puts the self memory first in the first (policy) section, in key order, ahead of policy statements', async () => {
    const h = harness();
    requiredItems(h.sources);
    const policyStatement = {
      itemId: 'policy.spend-approval',
      sourceRef: { source: 'policy', id: 'spend-approval' },
      trust: 'system' as const,
      text: 'Spend above 100 GBP per day needs explicit user approval.',
      observedAt: OBSERVED_AT,
    };
    h.sources.items('policy', [policyStatement, self('02-success', 'Success is a measured campaign.'), self('01-identity', 'I am Proba.')]);
    const packet = await buildContext(h.deps, request(), identity());
    expect(validateContextPacket(packet).success).toBe(true);
    const first = [...packet.sections].sort((a, b) => a.priority - b.priority)[0];
    expect(first.kind).toBe('policy');
    expect(first.items.map((i) => i.itemId)).toEqual(['self.01-identity', 'self.02-success', 'policy.spend-approval']);
    expect(first.items.slice(0, 2).every((i) => i.trust === 'system')).toBe(true);
  });

  it('is never trimmed for budget: optional sections are dropped first', async () => {
    const h = harness();
    requiredItems(h.sources);
    const long = 'x'.repeat(800);
    h.sources.items('policy', [self('01-identity', `I am Proba. ${long}`), self('02-rules', `Always propose. ${long}`)]);
    h.sources.items('memory', [item('proba-memory', { text: 'm'.repeat(900) }), item('proba-memory', { text: 'n'.repeat(900) })]);
    const packet = await buildContext(h.deps, request({ budgetTokens: 3200 }), identity());
    const policy = packet.sections.find((s) => s.kind === 'policy');
    expect(policy?.items.map((i) => i.itemId)).toEqual(['self.01-identity', 'self.02-rules']);
    const memory = packet.sections.find((s) => s.kind === 'memory');
    expect(memory?.items.length ?? 0).toBeLessThan(2);
  });

  it('keeps a self item that names no workspace or user (it belongs to nobody) through the scope check', async () => {
    const h = harness();
    requiredItems(h.sources);
    h.sources.items('policy', [self('01-identity', 'I am Proba.')]);
    const packet = await buildContext(h.deps, request(), identity({ workspaceId: 'seedbed' }));
    expect(packet.sections.find((s) => s.kind === 'policy')?.items[0]?.itemId).toBe('self.01-identity');
  });
});

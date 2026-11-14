import { describe, expect, it } from 'vitest';
import type { PolicySource } from '@smallseedlabs/proba-context-core';
import type { ContextItem } from '@smallseedlabs/proba-protocol';
import { actingQuery } from '../sources/__fixtures__/harness.js';
import { SelfAwarePolicySource } from './selfAwarePolicy.js';

const at = '2026-11-14T00:00:00.000Z';
const policyItem: ContextItem = { itemId: 'policy.spend-approval', sourceRef: { source: 'policy', id: 'spend-approval' }, trust: 'system', text: 'Spend needs approval.', observedAt: at };
const selfItem: ContextItem = { itemId: 'self.01-identity', sourceRef: { source: 'proba-self', id: '01-identity' }, trust: 'system', text: 'I am Proba.', score: 1, observedAt: at };
const base: PolicySource = { fetchPolicy: async () => ({ items: [policyItem] }) };

describe('SelfAwarePolicySource', () => {
  it('serves the self memory first, then the policy statements', async () => {
    const source = new SelfAwarePolicySource({ base, self: { fetchSelf: async () => [selfItem] } });
    expect((await source.fetchPolicy(actingQuery())).items.map((i) => i.itemId)).toEqual(['self.01-identity', 'policy.spend-approval']);
  });

  it('never fails the (build-critical) policy section when the self memory is unavailable', async () => {
    const reasons: string[] = [];
    const source = new SelfAwarePolicySource({ base, self: { fetchSelf: async () => Promise.reject(new Error('memory-api down')) }, onSelfUnavailable: (r) => reasons.push(r) });
    expect((await source.fetchPolicy(actingQuery())).items).toEqual([policyItem]);
    expect(reasons).toEqual(['memory-api down']);
  });

  it('gives up on a slow self memory within its own timeout', async () => {
    const reasons: string[] = [];
    const source = new SelfAwarePolicySource({ base, self: { fetchSelf: () => new Promise(() => undefined) }, selfTimeoutMs: 20, onSelfUnavailable: (r) => reasons.push(r) });
    expect((await source.fetchPolicy(actingQuery())).items).toEqual([policyItem]);
    expect(reasons[0]).toMatch(/timed out/);
  });

  it('still fails when the policy statements themselves fail (policy stays build-critical)', async () => {
    const source = new SelfAwarePolicySource({ base: { fetchPolicy: async () => Promise.reject(new Error('policy broken')) }, self: { fetchSelf: async () => [selfItem] } });
    await expect(source.fetchPolicy(actingQuery())).rejects.toThrow('policy broken');
  });
});

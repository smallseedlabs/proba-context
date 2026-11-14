import { describe, expect, it } from 'vitest';
import type { MemorySource, SourceQuery } from '@smallseedlabs/proba-context-core';
import type { ContextItem } from '@smallseedlabs/proba-protocol';
import { SelfAwareMemorySource } from './selfAwareMemory.js';

const at = '2026-11-14T00:00:00.000Z';
const mem = (id: string): ContextItem => ({ itemId: id, sourceRef: { source: 'proba-memory', id }, trust: 'user', text: id, observedAt: at });
const detail: ContextItem = { itemId: 'self.10-x', sourceRef: { source: 'proba-self', id: '10-x' }, trust: 'system', text: 'd', observedAt: at, data: { tier: 'detail', tags: ['tool:research.gather'] } };
const base: MemorySource = {
  recall: async () => ({ items: [mem('m1')] }),
  search: async () => ({ items: [mem('s1')] }),
};
const query = {} as SourceQuery;

describe('SelfAwareMemorySource', () => {
  it('adds the self detail candidates to the base recall, never to a memory_search need', async () => {
    const source = new SelfAwareMemorySource({ base, self: { fetchDetails: async () => [detail] } });
    expect((await source.recall(query, 5)).items.map((i) => i.itemId)).toEqual(['m1', 'self.10-x']);
    expect((await source.search(query, 'q', 5)).items.map((i) => i.itemId)).toEqual(['s1']);
  });

  it('returns the user memories alone when the self detail fails or is slow', async () => {
    const reasons: string[] = [];
    const failing = new SelfAwareMemorySource({ base, self: { fetchDetails: async () => { throw new Error('down'); } }, onSelfUnavailable: (r) => reasons.push(r) });
    expect((await failing.recall(query, 5)).items.map((i) => i.itemId)).toEqual(['m1']);
    const slow = new SelfAwareMemorySource({ base, selfTimeoutMs: 10, self: { fetchDetails: () => new Promise((r) => setTimeout(() => r([detail]), 200)) }, onSelfUnavailable: (r) => reasons.push(r) });
    expect((await slow.recall(query, 5)).items.map((i) => i.itemId)).toEqual(['m1']);
    expect(reasons).toEqual(['down', 'self detail timed out after 10ms']);
  });

  it('still fails the section when the base memory source fails', async () => {
    const source = new SelfAwareMemorySource({ base: { ...base, recall: async () => { throw new Error('memory-api down'); } }, self: { fetchDetails: async () => [detail] } });
    await expect(source.recall(query, 5)).rejects.toThrow('memory-api down');
  });
});

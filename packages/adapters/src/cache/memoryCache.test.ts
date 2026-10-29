import { describe, expect, it } from 'vitest';
import { buildCacheKey } from '@smallseedlabs/proba-context-core';
import { MemoryContextCache, MemoryContextCacheRefusedError } from './memoryCache.js';

const OBSERVED = '2026-10-28T00:00:00.000Z';

function payload(text: string) {
  return {
    returned: 1,
    items: [
      {
        itemId: 'm1',
        sourceRef: { source: 'memory', id: 'm1' },
        trust: 'user' as const,
        text,
        observedAt: OBSERVED,
      },
    ],
  };
}

function key(userId: string, workspaceId: string, goalId: string) {
  return buildCacheKey({
    source: 'memory',
    workspaceId,
    userId,
    goalId,
    params: { stepType: 'propose_budget' },
    configVersion: '1',
    templateVersion: '1',
  });
}

describe('MemoryContextCache', () => {
  it('refuses construction in production without an explicit allow', () => {
    expect(() => new MemoryContextCache({ nodeEnv: 'production' })).toThrow(MemoryContextCacheRefusedError);
    expect(() => new MemoryContextCache({ nodeEnv: 'production', allowInProduction: true })).not.toThrow();
  });

  it('hits and misses, and expires by the injected clock', async () => {
    let now = Date.parse(OBSERVED);
    const clock = { now: () => new Date(now) };
    const cache = new MemoryContextCache({ clock, nodeEnv: 'test' });
    const k = key('u1', 'seedbed', 'g1');
    expect(await cache.get(k)).toBeUndefined();
    await cache.set(k, payload('alpha'), 30);
    expect((await cache.get(k))?.items[0]?.text).toBe('alpha');
    now += 31_000;
    expect(await cache.get(k)).toBeUndefined();
  });

  it('never serves an entry across users or workspaces', async () => {
    const cache = new MemoryContextCache({ nodeEnv: 'test' });
    const a = key('u1', 'seedbed', 'g1');
    const otherUser = key('u2', 'seedbed', 'g1');
    const otherWs = key('u1', 'other', 'g1');
    await cache.set(a, payload('secret-a'), 60);
    expect(await cache.get(a)).toBeDefined();
    expect(await cache.get(otherUser)).toBeUndefined();
    expect(await cache.get(otherWs)).toBeUndefined();
  });

  it('invalidates by user or goal', async () => {
    const cache = new MemoryContextCache({ nodeEnv: 'test' });
    const k1 = key('u1', 'seedbed', 'g1');
    const k2 = key('u1', 'seedbed', 'g2');
    const k3 = key('u2', 'seedbed', 'g1');
    await cache.set(k1, payload('1'), 60);
    await cache.set(k2, payload('2'), 60);
    await cache.set(k3, payload('3'), 60);
    expect(await cache.invalidate({ userId: 'u1', workspaceId: 'seedbed' })).toBe(2);
    expect(await cache.get(k1)).toBeUndefined();
    expect(await cache.get(k2)).toBeUndefined();
    expect(await cache.get(k3)).toBeDefined();
    expect(await cache.invalidate({ goalId: 'g1', workspaceId: 'seedbed' })).toBe(1);
    expect(await cache.get(k3)).toBeUndefined();
  });
});

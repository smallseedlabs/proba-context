import { describe, expect, it } from 'vitest';
import { ContextMetrics, type CachedSourcePayload, type ContextCache } from '../index.js';
import { MemoryContextCache } from '@smallseedlabs/proba-context-adapters';
import { buildContext } from './buildContext.js';
import { harness, identity, item, requiredItems, request, IDS } from './__fixtures__/fixtures.js';

class RecordingCache implements ContextCache {
  readonly inner: MemoryContextCache;
  gets = 0;
  sets = 0;

  constructor(clock?: { now: () => Date }) {
    this.inner = new MemoryContextCache({ nodeEnv: 'test', ...(clock ? { clock } : {}) });
  }

  async get(key: string): Promise<CachedSourcePayload | undefined> {
    this.gets += 1;
    return this.inner.get(key);
  }
  async set(key: string, value: CachedSourcePayload, ttlSeconds: number): Promise<void> {
    this.sets += 1;
    return this.inner.set(key, value, ttlSeconds);
  }
  async delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }
  async invalidate(filter: { workspaceId?: string; userId?: string; goalId?: string }): Promise<number> {
    return this.inner.invalidate(filter);
  }
}

describe('per-source context cache in the pipeline', () => {
  it('proves caching is off by default: every build fetches and never hits', async () => {
    const h = harness();
    requiredItems(h.sources);
    h.sources.items('memory', [item('memory', { text: 'budget note' })]);
    const cache = new RecordingCache();
    h.deps.cache = cache;
    await buildContext(h.deps, request(), identity());
    await buildContext(h.deps, request({ stepId: 'step-2' }), identity());
    expect(cache.sets).toBe(0);
    expect(h.sources.calls.filter((c) => c === 'memory').length).toBe(2);
    const packet = await buildContext(h.deps, request({ stepId: 'step-3' }), identity());
    expect(packet.manifest.sources.memory.cacheHit).toBe(false);
  });

  it('hits on the second build when memory caching is enabled', async () => {
    const h = harness((c) => {
      c.sources.memory.cache = { enabled: true, ttlSeconds: 30, maxEntries: 100 };
    });
    requiredItems(h.sources);
    h.sources.items('memory', [item('memory', { text: 'budget note' })]);
    const cache = new RecordingCache();
    const metrics = new ContextMetrics();
    h.deps.cache = cache;
    h.deps.metrics = metrics;

    const first = await buildContext(h.deps, request(), identity());
    expect(first.manifest.sources.memory.cacheHit).toBe(false);
    expect(cache.sets).toBeGreaterThanOrEqual(1);
    expect(h.audit.actions).toContain('context.cache_miss');

    h.sources.calls.length = 0;
    const second = await buildContext(h.deps, request({ stepId: 'step-2' }), identity());
    expect(second.manifest.sources.memory.cacheHit).toBe(true);
    expect(h.sources.calls.filter((c) => c === 'memory')).toEqual([]);
    expect(h.audit.actions).toContain('context.cache_hit');
    expect(metrics.cacheHitRatio('memory')).toBeGreaterThan(0);
    expect(metrics.render()).toContain('context_cache_hits_total');
  });

  it('does not reuse a cached entry for another user or workspace', async () => {
    const h = harness((c) => {
      c.sources.memory.cache = { enabled: true, ttlSeconds: 30, maxEntries: 100 };
    });
    requiredItems(h.sources);
    h.sources.items('memory', [item('memory', { text: 'mine' })]);
    const cache = new RecordingCache();
    h.deps.cache = cache;

    await buildContext(h.deps, request(), identity());
    expect(cache.sets).toBeGreaterThanOrEqual(1);

    h.sources.calls.length = 0;
    await buildContext(
      h.deps,
      request({ userId: IDS.otherUser, stepId: 'step-other' }),
      identity({ userId: IDS.otherUser, subject: IDS.otherUser })
    );
    expect(h.sources.calls).toContain('memory');

    h.sources.calls.length = 0;
    await buildContext(
      h.deps,
      request({ workspaceId: 'other-ws', stepId: 'step-ws' }),
      identity({ workspaceId: 'other-ws' })
    );
    expect(h.sources.calls).toContain('memory');
  });

  it('expires entries when the injected clock advances past the TTL', async () => {
    let now = Date.parse('2026-10-28T00:00:00.000Z');
    const clock = { now: () => new Date(now) };
    const h = harness((c) => {
      c.sources.memory.cache = { enabled: true, ttlSeconds: 10, maxEntries: 100 };
    });
    h.deps.clock = clock;
    requiredItems(h.sources);
    h.sources.items('memory', [item('memory', { text: 'ttl' })]);
    const cache = new RecordingCache(clock);
    h.deps.cache = cache;

    await buildContext(h.deps, request(), identity());
    now += 11_000;
    h.sources.calls.length = 0;
    const packet = await buildContext(h.deps, request({ stepId: 'step-2' }), identity());
    expect(packet.manifest.sources.memory.cacheHit).toBe(false);
    expect(h.sources.calls).toContain('memory');
  });

  it('invalidation clears entries for a goal', async () => {
    const h = harness((c) => {
      c.sources.memory.cache = { enabled: true, ttlSeconds: 60, maxEntries: 100 };
    });
    requiredItems(h.sources);
    h.sources.items('memory', [item('memory', { text: 'x' })]);
    const cache = new RecordingCache();
    h.deps.cache = cache;
    await buildContext(h.deps, request(), identity());
    await cache.invalidate({ workspaceId: IDS.workspace, goalId: IDS.goal });
    h.sources.calls.length = 0;
    await buildContext(h.deps, request({ stepId: 'step-2' }), identity());
    expect(h.sources.calls).toContain('memory');
  });

  it('records metrics for builds, gaps and tokens', async () => {
    const h = harness();
    requiredItems(h.sources);
    const metrics = new ContextMetrics();
    h.deps.metrics = metrics;
    const packet = await buildContext(h.deps, request(), identity());
    const text = metrics.render();
    expect(text).toContain('context_builds_total');
    expect(text).toContain('context_build_duration_ms');
    expect(text).toContain('context_gaps_total');
    expect(text).toContain(`version="${packet.configVersion}"`);
    expect(text).toContain('context_tokens_total');
    expect(text).not.toMatch(/userId|workspaceId/);
  });
});

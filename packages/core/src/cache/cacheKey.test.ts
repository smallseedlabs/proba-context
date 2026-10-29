import { describe, expect, it } from 'vitest';
import { buildCacheKey, canonicalizeCacheParams, sourceUsesGoalId } from './cacheKey.js';

describe('cache key', () => {
  it('embeds workspace, user and goal and is stable for equal params', () => {
    const a = buildCacheKey({
      source: 'memory',
      workspaceId: 'seedbed',
      userId: 'u1',
      goalId: 'g1',
      params: { stepType: 'propose_budget', profile: null },
      configVersion: '1',
      templateVersion: '1',
    });
    const b = buildCacheKey({
      source: 'memory',
      workspaceId: 'seedbed',
      userId: 'u1',
      goalId: 'g1',
      params: { profile: null, stepType: 'propose_budget' },
      configVersion: '1',
      templateVersion: '1',
    });
    expect(a).toBe(b);
    expect(a).toContain(':seedbed:u1:g1:memory:');
  });

  it('differs across users, workspaces, goals and config versions', () => {
    const base = {
      source: 'memory' as const,
      workspaceId: 'seedbed',
      userId: 'u1',
      goalId: 'g1',
      params: { stepType: 'propose_budget' },
      configVersion: '1',
      templateVersion: '1',
    };
    expect(buildCacheKey({ ...base, userId: 'u2' })).not.toBe(buildCacheKey(base));
    expect(buildCacheKey({ ...base, workspaceId: 'other' })).not.toBe(buildCacheKey(base));
    expect(buildCacheKey({ ...base, goalId: 'g2' })).not.toBe(buildCacheKey(base));
    expect(buildCacheKey({ ...base, configVersion: '2' })).not.toBe(buildCacheKey(base));
  });

  it('omits goal from the key material for policy and tools', () => {
    expect(sourceUsesGoalId('policy')).toBe(false);
    expect(sourceUsesGoalId('memory')).toBe(true);
    const withGoal = buildCacheKey({
      source: 'policy',
      workspaceId: 'seedbed',
      userId: 'u1',
      goalId: 'g1',
      params: {},
      configVersion: '1',
    });
    expect(withGoal).toContain(':seedbed:u1:_:policy:');
  });

  it('canonicalises params with sorted keys', () => {
    expect(canonicalizeCacheParams({ b: 1, a: 2 })).toBe(canonicalizeCacheParams({ a: 2, b: 1 }));
  });
});

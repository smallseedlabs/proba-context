import { describe, expect, it } from 'vitest';
import { ContextMetrics } from './registry.js';

describe('ContextMetrics', () => {
  it('renders prometheus text with hit ratio helpers and no user labels', () => {
    const m = new ContextMetrics();
    m.setConfigVersion('1');
    m.incCacheMiss('memory');
    m.incCacheHit('memory');
    m.observeSourceLatency('memory', 12);
    m.observeBuildDuration(40, 'success');
    m.addItems('memory', 3, 2, 1);
    m.incGap('no_analytics_for_campaign');
    m.addScopeViolations(1);
    m.addTokens('policy', 10);
    expect(m.cacheHitRatio('memory')).toBe(0.5);
    const text = m.render();
    expect(text).toContain('# TYPE context_cache_hits_total counter');
    expect(text).toContain('context_cache_hits_total{source="memory"} 1');
    expect(text).toContain('context_config_version_info{version="1"} 1');
    expect(text).not.toMatch(/user_id|workspace_id|userId/);
  });
});

/**
 * In-process Prometheus text exposition for context-api `/metrics`.
 * Labels never carry user ids, workspace ids, or item text — only source names, gap codes and section kinds.
 */

export type MetricLabels = Record<string, string>;

interface CounterSeries {
  name: string;
  help: string;
  type: 'counter';
  values: Map<string, number>;
}

interface GaugeSeries {
  name: string;
  help: string;
  type: 'gauge';
  values: Map<string, number>;
}

interface HistogramSeries {
  name: string;
  help: string;
  type: 'histogram';
  buckets: readonly number[];
  series: Map<string, { counts: number[]; sum: number; count: number }>;
}

function labelKey(labels: MetricLabels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${JSON.stringify(labels[k] ?? '')}`).join(',');
}

function formatLabels(key: string): string {
  return key.length === 0 ? '' : `{${key}}`;
}

const DEFAULT_LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000] as const;

/**
 * Collects the Phase-5 bridge metrics. Safe to share across requests on one process.
 */
export class ContextMetrics {
  private readonly counters = new Map<string, CounterSeries>();
  private readonly gauges = new Map<string, GaugeSeries>();
  private readonly histograms = new Map<string, HistogramSeries>();
  private configVersion = 'unknown';

  constructor() {
    this.ensureCounter(
      'context_source_requests_total',
      'Context source fetch attempts (cache hit or miss).',
      ['source', 'result']
    );
    this.ensureCounter('context_cache_hits_total', 'Context source cache hits.', ['source']);
    this.ensureCounter('context_cache_misses_total', 'Context source cache misses.', ['source']);
    this.ensureCounter('context_items_returned_total', 'Items returned by sources before budgeting.', ['source']);
    this.ensureCounter('context_items_included_total', 'Items included in the packet.', ['source']);
    this.ensureCounter('context_items_dropped_total', 'Items dropped (scope, budget, policy, invalid).', ['source']);
    this.ensureCounter('context_gaps_total', 'Gaps attached to packets.', ['code']);
    this.ensureCounter('context_scope_violations_total', 'Items dropped for scope violations.');
    this.ensureCounter('context_builds_total', 'Context builds completed.', ['outcome']);
    this.ensureCounter('context_tokens_total', 'Tokens included in packet sections.', ['section']);
    this.ensureHistogram(
      'context_source_latency_ms',
      'Per-source fetch latency in milliseconds (includes cache hits).',
      DEFAULT_LATENCY_BUCKETS_MS
    );
    this.ensureHistogram('context_build_duration_ms', 'Full context build duration in milliseconds.', DEFAULT_LATENCY_BUCKETS_MS);
    this.ensureGauge('context_config_version_info', 'Active config version (1 = current).', ['version']);
  }

  setConfigVersion(version: string): void {
    if (this.configVersion !== 'unknown') {
      this.gauge('context_config_version_info', 0, { version: this.configVersion });
    }
    this.configVersion = version;
    this.gauge('context_config_version_info', 1, { version });
  }

  getConfigVersion(): string {
    return this.configVersion;
  }

  /** Cache hit ratio for a source in [0, 1], or 0 when there were no requests. */
  cacheHitRatio(source: string): number {
    const hits = this.counterValue('context_cache_hits_total', { source });
    const misses = this.counterValue('context_cache_misses_total', { source });
    const total = hits + misses;
    return total === 0 ? 0 : hits / total;
  }

  incSourceRequest(source: string, result: 'hit' | 'miss' | 'fetch'): void {
    this.inc('context_source_requests_total', 1, { source, result });
  }

  incCacheHit(source: string): void {
    this.inc('context_cache_hits_total', 1, { source });
    this.incSourceRequest(source, 'hit');
  }

  incCacheMiss(source: string): void {
    this.inc('context_cache_misses_total', 1, { source });
    this.incSourceRequest(source, 'miss');
  }

  observeSourceLatency(source: string, ms: number): void {
    this.observe('context_source_latency_ms', ms, { source });
  }

  observeBuildDuration(ms: number, outcome: 'success' | 'failure'): void {
    this.observe('context_build_duration_ms', ms);
    this.inc('context_builds_total', 1, { outcome });
  }

  addItems(source: string, returned: number, included: number, dropped: number): void {
    if (returned > 0) this.inc('context_items_returned_total', returned, { source });
    if (included > 0) this.inc('context_items_included_total', included, { source });
    if (dropped > 0) this.inc('context_items_dropped_total', dropped, { source });
  }

  incGap(code: string): void {
    this.inc('context_gaps_total', 1, { code });
  }

  addScopeViolations(n: number): void {
    if (n > 0) this.inc('context_scope_violations_total', n);
  }

  addTokens(section: string, tokens: number): void {
    if (tokens > 0) this.inc('context_tokens_total', tokens, { section });
  }

  /** Prometheus text exposition (OpenMetrics-compatible 0.0.4). */
  render(): string {
    const lines: string[] = [];
    for (const series of this.counters.values()) {
      lines.push(`# HELP ${series.name} ${series.help}`);
      lines.push(`# TYPE ${series.name} counter`);
      for (const [key, value] of [...series.values.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        lines.push(`${series.name}${formatLabels(key)} ${value}`);
      }
    }
    for (const series of this.gauges.values()) {
      lines.push(`# HELP ${series.name} ${series.help}`);
      lines.push(`# TYPE ${series.name} gauge`);
      for (const [key, value] of [...series.values.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        lines.push(`${series.name}${formatLabels(key)} ${value}`);
      }
    }
    for (const series of this.histograms.values()) {
      lines.push(`# HELP ${series.name} ${series.help}`);
      lines.push(`# TYPE ${series.name} histogram`);
      for (const [key, data] of [...series.series.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        let cumulative = 0;
        for (let i = 0; i < series.buckets.length; i += 1) {
          cumulative += data.counts[i] ?? 0;
          const bucketLabels = key.length === 0 ? `le="${series.buckets[i]}"` : `${key},le="${series.buckets[i]}"`;
          lines.push(`${series.name}_bucket{${bucketLabels}} ${cumulative}`);
        }
        cumulative += data.counts[series.buckets.length] ?? 0;
        const infLabels = key.length === 0 ? 'le="+Inf"' : `${key},le="+Inf"`;
        lines.push(`${series.name}_bucket{${infLabels}} ${cumulative}`);
        lines.push(`${series.name}_sum${formatLabels(key)} ${data.sum}`);
        lines.push(`${series.name}_count${formatLabels(key)} ${data.count}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  private ensureCounter(name: string, help: string, _labelNames?: string[]): void {
    this.counters.set(name, { name, help, type: 'counter', values: new Map() });
  }

  private ensureGauge(name: string, help: string, _labelNames?: string[]): void {
    this.gauges.set(name, { name, help, type: 'gauge', values: new Map() });
  }

  private ensureHistogram(name: string, help: string, buckets: readonly number[]): void {
    this.histograms.set(name, { name, help, type: 'histogram', buckets, series: new Map() });
  }

  private inc(name: string, amount: number, labels: MetricLabels = {}): void {
    const series = this.counters.get(name);
    if (!series) return;
    const key = labelKey(labels);
    series.values.set(key, (series.values.get(key) ?? 0) + amount);
  }

  private gauge(name: string, value: number, labels: MetricLabels = {}): void {
    const series = this.gauges.get(name);
    if (!series) return;
    series.values.set(labelKey(labels), value);
  }

  private observe(name: string, value: number, labels: MetricLabels = {}): void {
    const series = this.histograms.get(name);
    if (!series) return;
    const key = labelKey(labels);
    let data = series.series.get(key);
    if (!data) {
      data = { counts: new Array(series.buckets.length + 1).fill(0), sum: 0, count: 0 };
      series.series.set(key, data);
    }
    let placed = false;
    for (let i = 0; i < series.buckets.length; i += 1) {
      if (value <= (series.buckets[i] as number)) {
        data.counts[i] = (data.counts[i] ?? 0) + 1;
        placed = true;
        break;
      }
    }
    if (!placed) data.counts[series.buckets.length] = (data.counts[series.buckets.length] ?? 0) + 1;
    data.sum += value;
    data.count += 1;
  }

  private counterValue(name: string, labels: MetricLabels): number {
    return this.counters.get(name)?.values.get(labelKey(labels)) ?? 0;
  }
}

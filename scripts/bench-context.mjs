#!/usr/bin/env node
/**
 * Builds context packets repeatedly against a running bridge and prints p50 / p95.
 *
 * Usage:
 *   node scripts/bench-context.mjs --url http://127.0.0.1:3500 --token "$ASSERTION" [--rounds 50]
 *
 * Mint an act-as assertion (or local bearer outside production) and pass it as --token.
 * Run once with caching off, turn on a source cache (see docs/CONFIG.md), SIGHUP or restart,
 * then run again and compare /metrics cache hit ratio.
 */
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:3500' },
    token: { type: 'string' },
    rounds: { type: 'string', default: '40' },
    stepType: { type: 'string', default: 'propose_budget' },
    workspaceId: { type: 'string', default: 'seedbed' },
    userId: { type: 'string', default: '660e8400-e29b-41d4-a716-446655440001' },
    goalId: { type: 'string', default: '770e8400-e29b-41d4-a716-446655440002' },
    threadId: { type: 'string', default: '880e8400-e29b-41d4-a716-446655440003' },
  },
});

if (!values.token) {
  console.error('Missing --token (Authorization bearer value, with or without the "Bearer " prefix).');
  process.exit(2);
}

const base = values.url.replace(/\/$/, '');
const rounds = Math.max(1, Number(values.rounds) || 40);
const auth = values.token.startsWith('Bearer ') ? values.token : `Bearer ${values.token}`;

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

const durations = [];
let failures = 0;
for (let i = 0; i < rounds; i += 1) {
  const body = {
    traceId: crypto.randomUUID(),
    workspaceId: values.workspaceId,
    userId: values.userId,
    goalId: values.goalId,
    threadId: values.threadId,
    stepId: `bench-${i}`,
    stepType: values.stepType,
  };
  const started = performance.now();
  const res = await fetch(`${base}/v1/context/build`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ms = performance.now() - started;
  if (!res.ok) {
    failures += 1;
    const text = await res.text();
    console.error(`round ${i}: HTTP ${res.status} ${text.slice(0, 200)}`);
    continue;
  }
  durations.push(ms);
}

durations.sort((a, b) => a - b);
const metricsRes = await fetch(`${base}/metrics`);
const metricsText = metricsRes.ok ? await metricsRes.text() : '';

console.log(
  JSON.stringify(
    {
      url: base,
      rounds,
      ok: durations.length,
      failures,
      p50Ms: Number(percentile(durations, 50).toFixed(2)),
      p95Ms: Number(percentile(durations, 95).toFixed(2)),
      meanMs: durations.length
        ? Number((durations.reduce((s, n) => s + n, 0) / durations.length).toFixed(2))
        : null,
      metricsSnippet: metricsText
        .split('\n')
        .filter((l) => l.startsWith('context_cache_') || l.startsWith('context_build_duration_ms_'))
        .slice(0, 40),
    },
    null,
    2
  )
);

if (failures > 0) process.exit(1);

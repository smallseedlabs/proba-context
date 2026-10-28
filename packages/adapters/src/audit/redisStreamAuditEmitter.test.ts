import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { buildAuditEvent } from '@smallseedlabs/proba-context-core';
import { DEFAULT_AUDIT_STREAM, RedisStreamAuditEmitter, createRedisStreamAuditEmitter, type StreamClient } from './redisStreamAuditEmitter.js';
import { LogAuditEmitter, LogAuditEmitterRefusedError } from './logAuditEmitter.js';

const clock = { now: () => new Date('2026-10-28T00:00:00.000Z') };

function event(overrides: Record<string, unknown> = {}) {
  return buildAuditEvent({
    traceId: '550e8400-e29b-41d4-a716-446655440000',
    workspaceId: 'seedbed',
    userId: '660e8400-e29b-41d4-a716-446655440001',
    actor: { type: 'service', id: 'proba-context' },
    service: 'proba-context',
    action: 'context.requested',
    category: 'data_access',
    outcome: 'success',
    ...overrides,
  });
}

function recorder(): StreamClient & { calls: Array<Array<string | number>> } {
  const calls: Array<Array<string | number>> = [];
  return {
    calls,
    async xadd(key, ...args) {
      calls.push([key, ...args]);
      return '1-0';
    },
  };
}

describe('RedisStreamAuditEmitter', () => {
  it('appends data, publishedAt and key to proba.audit.events', async () => {
    const client = recorder();
    const e = event();
    await new RedisStreamAuditEmitter({ client, clock }).emit(e);
    expect(client.calls).toHaveLength(1);
    const [key, id, f1, data, f2, publishedAt, f3, partition] = client.calls[0] as string[];
    expect(key).toBe('proba.audit.events');
    expect(DEFAULT_AUDIT_STREAM).toBe('proba.audit.events');
    expect(id).toBe('*');
    expect([f1, f2, f3]).toEqual(['data', 'publishedAt', 'key']);
    expect(JSON.parse(data as string)).toMatchObject({ eventId: e.eventId, action: 'context.requested', service: 'proba-context' });
    expect(publishedAt).toBe('2026-10-28T00:00:00.000Z');
    expect(partition).toBe('seedbed');
  });

  it('trims approximately when maxStreamLength is set and honours a custom stream', async () => {
    const client = recorder();
    await new RedisStreamAuditEmitter({ client, clock, stream: 's', maxStreamLength: 1000 }).emit(event());
    expect(client.calls[0]?.slice(0, 5)).toEqual(['s', 'MAXLEN', '~', 1000, '*']);
  });

  it('rejects an event that is not a valid AuditEvent and writes nothing', async () => {
    const client = recorder();
    await expect(new RedisStreamAuditEmitter({ client, clock }).emit(event({ action: 'NotDotted' }))).rejects.toThrow(/not a valid AuditEvent/);
    expect(client.calls).toEqual([]);
  });

  it('propagates a Redis failure so the caller can fail closed', async () => {
    const client: StreamClient = {
      async xadd() {
        throw new Error('connection refused');
      },
    };
    await expect(new RedisStreamAuditEmitter({ client, clock }).emit(event())).rejects.toThrow('connection refused');
  });
});

// Runs against a real Redis only when one is named; skipped otherwise.
describe.skipIf(!process.env.TEST_REDIS_URL)('RedisStreamAuditEmitter against Redis', () => {
  const stream = `proba.audit.events.${Date.now()}`;
  const url = process.env.TEST_REDIS_URL as string;
  const emitter = createRedisStreamAuditEmitter({ url, clock, stream });
  afterAll(async () => {
    const r = new Redis(url);
    await r.del(stream);
    await r.quit();
    await emitter.close();
  });

  it('adds the entry to the stream', async () => {
    const e = event();
    await emitter.emit(e);
    const r = new Redis(url);
    const entries = await r.xrange(stream, '-', '+');
    await r.quit();
    expect(entries).toHaveLength(1);
    const fields = entries[0]?.[1] as string[];
    expect(JSON.parse(fields[1] as string).eventId).toBe(e.eventId);
  });
});

describe('LogAuditEmitter', () => {
  it('writes one line per event with ids and outcome but no details', async () => {
    const lines: string[] = [];
    await new LogAuditEmitter({ write: (l) => lines.push(l) }, 'development').emit(event({ details: { secretish: 'x' } }));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ audit: true, action: 'context.requested', outcome: 'success' });
    expect(lines[0]).not.toContain('secretish');
  });

  it('is refused in production', () => {
    expect(() => new LogAuditEmitter({ write: () => undefined }, 'production')).toThrow(LogAuditEmitterRefusedError);
  });
});

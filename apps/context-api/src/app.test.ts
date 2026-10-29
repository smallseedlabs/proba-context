import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  validateAuditEvent,
  validateContextPacket,
  type AuditEmitter,
  type AuditEventInput,
  type ContextPacket,
} from '@smallseedlabs/proba-context-core';
import {
  MemoryContextCache,
  MemoryContextCacheRefusedError,
  MemoryJtiStore,
  MemoryPacketStore,
  MemoryRateLimiter,
  MemoryRateLimiterRefusedError,
  MemoryJtiStoreRefusedError,
  MemoryPacketStoreRefusedError,
  RedisCachePasswordRequiredError,
  UnconfiguredIdentityResolver,
  assertRedisPassword,
} from '@smallseedlabs/proba-context-adapters';
import { buildApp, type ContextServices } from './app.js';
import { createRuntime } from './runtime.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const configPath = join(repoRoot, 'config', 'context.config.yaml');

const IDS = {
  trace: '550e8400-e29b-41d4-a716-446655440000',
  user: '660e8400-e29b-41d4-a716-446655440001',
  goal: '770e8400-e29b-41d4-a716-446655440002',
  thread: '880e8400-e29b-41d4-a716-446655440003',
};
const bearer = `Bearer local:${IDS.user}:seedbed:${IDS.goal}:${IDS.thread}`;
const body = (overrides: Record<string, unknown> = {}) => ({
  traceId: IDS.trace,
  workspaceId: 'seedbed',
  userId: IDS.user,
  goalId: IDS.goal,
  threadId: IDS.thread,
  stepId: 'step-propose-budget-1',
  stepType: 'propose_budget',
  ...overrides,
});

class RecordingEmitter implements AuditEmitter {
  readonly events: AuditEventInput[] = [];
  async emit(event: AuditEventInput): Promise<void> {
    this.events.push(event);
  }
}

function servicesWithRecorder(): { services: ContextServices; audit: RecordingEmitter } {
  const runtime = createRuntime({ NODE_ENV: 'test', CONTEXT_ALLOW_LOCAL_IDENTITY: 'true' }, configPath);
  const audit = new RecordingEmitter();
  return { services: { ...runtime.services, deps: { ...runtime.services.deps, audit } }, audit };
}

describe('GET /health', () => {
  it('reports the service as ok', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'context-api' });
    expect(res.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('is still served next to the context routes', async () => {
    const app = await buildApp({}, servicesWithRecorder().services);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    await app.close();
  });

  it('serves no context routes without services', async () => {
    const app = await buildApp();
    expect((await app.inject({ method: 'POST', url: '/v1/context/build', payload: body() })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/context' })).statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /v1/context/build', () => {
  it('builds the raise-the-budget packet from config policy, tools and the identity', async () => {
    const { services, audit } = servicesWithRecorder();
    const app = await buildApp({}, services);
    const res = await app.inject({ method: 'POST', url: '/v1/context/build', headers: { authorization: bearer }, payload: body() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const packet = res.json<ContextPacket>();
    expect(validateContextPacket(packet).success).toBe(true);
    expect(packet.sections.map((s) => s.kind)).toEqual(['policy', 'task', 'tools']);
    expect(packet.sections.find((s) => s.kind === 'policy')?.items[0]?.sourceRef).toEqual({ source: 'policy', id: 'spend-approval' });
    expect(packet.sections.find((s) => s.kind === 'tools')?.items.map((i) => (i.data as { name: string }).name)).toEqual(['propose_budget']);
    expect(packet.gaps.map((g) => g.code)).toEqual(['no_analytics_for_campaign']);
    expect(audit.events.map((e) => e.action)).toEqual([
      'context.requested',
      'context.source_fetched',
      'context.source_fetched',
      'context.source_fetched',
      'context.source_fetched',
      'context.source_fetched',
      'context.source_fetched',
      'context.gap_detected',
      'context.built',
    ]);
    for (const event of audit.events) expect(validateAuditEvent(event).success).toBe(true);
    await app.close();
  });

  it('accepts the X-Local-Identity header', async () => {
    const app = await buildApp({}, servicesWithRecorder().services);
    const identity = JSON.stringify({ userId: IDS.user, workspaceId: 'seedbed', goalId: IDS.goal, threadId: IDS.thread });
    const res = await app.inject({ method: 'POST', url: '/v1/context/build', headers: { 'x-local-identity': identity }, payload: body() });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('answers 401 without an identity and 401 for a malformed one', async () => {
    const { services, audit } = servicesWithRecorder();
    const app = await buildApp({}, services);
    const none = await app.inject({ method: 'POST', url: '/v1/context/build', payload: body() });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toEqual({ error: { code: 'identity_missing', message: expect.any(String) } });
    expect(audit.events.some((e) => e.action === 'auth.denied')).toBe(true);
    const bad = await app.inject({ method: 'POST', url: '/v1/context/build', headers: { authorization: 'Bearer local:a:b' }, payload: body() });
    expect(bad.statusCode).toBe(401);
    await app.close();
  });

  it('answers 403 when the body names a different user than the identity, and audits the denial', async () => {
    const { services, audit } = servicesWithRecorder();
    const app = await buildApp({}, services);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/context/build',
      headers: { authorization: bearer },
      payload: body({ userId: '660e8400-e29b-41d4-a716-446655440099' }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('identity_mismatch');
    expect(audit.events.map((e) => e.action)).toEqual(['context.requested', 'context.build_failed', 'auth.denied']);
    expect(audit.events[1]?.outcome).toBe('denied');
    await app.close();
  });

  it('answers 400 with the offending paths for an invalid body', async () => {
    const app = await buildApp({}, servicesWithRecorder().services);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/context/build',
      headers: { authorization: bearer },
      payload: body({ stepType: 'nope', traceId: 'x' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.issues.map((i: { path: string }) => i.path).sort()).toEqual(['stepType', 'traceId']);
    await app.close();
  });

  it('answers 422 when the budget cannot hold policy, task and tools', async () => {
    const app = await buildApp({}, servicesWithRecorder().services);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/context/build',
      headers: { authorization: bearer },
      payload: body({ budgetTokens: 5 }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('budget_exceeded_by_required');
    await app.close();
  });

  it('answers 503 when the audit trail cannot be written', async () => {
    const { services } = servicesWithRecorder();
    const failing: AuditEmitter = {
      async emit() {
        throw new Error('redis down at 10.1.2.3');
      },
    };
    const app = await buildApp({ logger: false }, { ...services, deps: { ...services.deps, audit: failing } });
    const res = await app.inject({ method: 'POST', url: '/v1/context/build', headers: { authorization: bearer }, payload: body() });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain('10.1.2.3');
    await app.close();
  });

  it('rejects a body larger than limits.maxRequestBytes', async () => {
    const { services } = servicesWithRecorder();
    const config = { ...services.deps.config, limits: { ...services.deps.config.limits, maxRequestBytes: 300 } };
    const app = await buildApp({}, { ...services, deps: { ...services.deps, config } });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/context/build',
      headers: { authorization: bearer },
      payload: body({ stepId: 'x'.repeat(1000) }),
    });
    expect(res.statusCode).toBe(413);
    await app.close();
  });
});

describe('production refuses local identity', () => {
  it('has no local identity resolver: context requests are answered 503 even with a local bearer', async () => {
    const { services } = servicesWithRecorder();
    const app = await buildApp({}, { ...services, identity: new UnconfiguredIdentityResolver() });
    const build = await app.inject({ method: 'POST', url: '/v1/context/build', headers: { authorization: bearer }, payload: body() });
    expect(build.statusCode).toBe(503);
    expect(build.json().error.code).toBe('identity_unconfigured');
    const needs = await app.inject({ method: 'GET', url: '/v1/context/needs?stepType=propose_budget', headers: { authorization: bearer } });
    expect(needs.statusCode).toBe(503);
    await app.close();
  });

  it('createRuntime refuses to start in production without assertion keys', () => {
    expect(() =>
      createRuntime(
        {
          NODE_ENV: 'production',
          REDIS_URL: 'redis://:pw@redis:6379',
          DATABASE_URL: 'postgresql://proba:pw@postgres:5432/proba_context',
        },
        configPath
      )
    ).toThrow(/HUB_ASSERTION_PUBLIC_KEY_FILE/);
  });

  it('createRuntime refuses to start in production without a Redis audit stream', () => {
    expect(() => createRuntime({ NODE_ENV: 'production' }, configPath)).toThrow(/REDIS_URL is required/);
  });

  it('createRuntime refuses to start in production without DATABASE_URL for packet manifests', () => {
    expect(() =>
      createRuntime({ NODE_ENV: 'production', REDIS_URL: 'redis://:pw@redis:6379' }, configPath)
    ).toThrow(/DATABASE_URL is required/);
  });

  it('createRuntime refuses a Redis host that is not in allowedDownstreamHosts', () => {
    expect(() => createRuntime({ NODE_ENV: 'production', REDIS_URL: 'redis://elsewhere:6379' }, configPath)).toThrow(
      /allowedDownstreamHosts/
    );
  });

  it('createRuntime refuses a DATABASE_URL host that is not in allowedDownstreamHosts', () => {
    expect(() =>
      createRuntime(
        {
          NODE_ENV: 'production',
          REDIS_URL: 'redis://:pw@redis:6379',
          DATABASE_URL: 'postgresql://proba:pw@elsewhere:5432/proba_context',
        },
        configPath
      )
    ).toThrow(/allowedDownstreamHosts/);
  });

  it('outside production createRuntime uses local identity only when the flag is set', () => {
    const withFlag = createRuntime({ NODE_ENV: 'test', CONTEXT_ALLOW_LOCAL_IDENTITY: 'true' }, configPath);
    expect(withFlag.identityMode).toBe('local_identity');
    expect(withFlag.auditSink).toBe('log');
    expect(withFlag.httpSources).toEqual([]);

    const without = createRuntime({ NODE_ENV: 'test' }, configPath);
    expect(without.identityMode).toBe('unconfigured');
  });

  it('refuses memory rate limiter, jti store and packet store in production', () => {
    expect(() => new MemoryRateLimiter(undefined, 'production')).toThrow(MemoryRateLimiterRefusedError);
    expect(() => new MemoryJtiStore(undefined, 'production')).toThrow(MemoryJtiStoreRefusedError);
    expect(() => new MemoryPacketStore('production')).toThrow(MemoryPacketStoreRefusedError);
  });

  it('refuses in-process context cache in production unless explicitly allowed', () => {
    expect(() => new MemoryContextCache({ nodeEnv: 'production' })).toThrow(MemoryContextCacheRefusedError);
    expect(() => new MemoryContextCache({ nodeEnv: 'production', allowInProduction: true })).not.toThrow();
  });

  it('refuses passwordless Redis for the context cache in production', () => {
    expect(() => assertRedisPassword('redis://redis:6379', 'production')).toThrow(RedisCachePasswordRequiredError);
  });
});

describe('ready, metrics and cache off by default', () => {
  it('serves /ready with the active config version', async () => {
    const app = await buildApp({}, servicesWithRecorder().services);
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ready',
      service: 'context-api',
      configVersion: '1',
      checks: { config: 'ok', cache: 'ok', packetStore: 'ok' },
    });
    await app.close();
  });

  it('exposes Prometheus /metrics without user ids', async () => {
    const { services } = servicesWithRecorder();
    const app = await buildApp({}, services);
    await app.inject({ method: 'POST', url: '/v1/context/build', headers: { authorization: bearer }, payload: body() });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.body).toContain('context_builds_total');
    expect(res.body).toContain('context_config_version_info');
    expect(res.body).not.toMatch(IDS.user);
    await app.close();
  });

  it('leaves every source cache off in the shipped config so builds miss', async () => {
    const { services } = servicesWithRecorder();
    expect(Object.values(services.deps.config.sources).every((s) => !s.cache.enabled)).toBe(true);
    const app = await buildApp({}, services);
    const res = await app.inject({ method: 'POST', url: '/v1/context/build', headers: { authorization: bearer }, payload: body() });
    expect(res.statusCode).toBe(200);
    const packet = res.json<ContextPacket>();
    for (const source of Object.values(packet.manifest.sources)) {
      expect(source.cacheHit).toBe(false);
    }
    await app.close();
  });
});

describe('GET /v1/context/needs', () => {
  it('lists the need kinds policy allows for the step', async () => {
    const app = await buildApp({}, servicesWithRecorder().services);
    const get = (stepType: string) =>
      app.inject({ method: 'GET', url: `/v1/context/needs?stepType=${stepType}`, headers: { authorization: bearer } });
    const propose = (await get('propose_budget')).json();
    expect(propose.stepType).toBe('propose_budget');
    expect(propose.maxNeedsPerRequest).toBe(20);
    expect(propose.maxRoundsPerStep).toBe(2);
    expect(propose.extraTokenShare).toBe(0.3);
    expect(propose.allowedNeeds.map((n: { kind: string }) => n.kind)).toEqual([
      'memory_search',
      'analytics_compare',
      'conversation_before',
    ]);
    expect(propose.allowedNeeds.find((n: { kind: string }) => n.kind === 'analytics_compare')).toMatchObject({
      source: 'analytics',
      maxItems: 10,
      allowedWindows: ['1d', '7d', '14d', '30d'],
    });
    expect((await get('explain_decision')).json().allowedNeeds.map((n: { kind: string }) => n.kind)).toEqual([
      'memory_search',
      'analytics_compare',
      'audit_trace',
      'conversation_before',
    ]);
    expect((await get('launch_campaign')).json().allowedNeeds.map((n: { kind: string }) => n.kind)).toEqual([
      'memory_search',
      'conversation_before',
    ]);
    await app.close();
  });

  it('answers 400 for a missing or unknown stepType and 401 without an identity', async () => {
    const app = await buildApp({}, servicesWithRecorder().services);
    expect((await app.inject({ method: 'GET', url: '/v1/context/needs', headers: { authorization: bearer } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/v1/context/needs?stepType=zzz', headers: { authorization: bearer } })).statusCode).toBe(
      400
    );
    expect((await app.inject({ method: 'GET', url: '/v1/context/needs?stepType=propose_budget' })).statusCode).toBe(401);
    await app.close();
  });
});

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalJWKSet } from 'jose';
import { describe, expect, it } from 'vitest';
import type { AuditEmitter, AuditEventInput, ContextPacket } from '@smallseedlabs/proba-context-core';
import {
  ActAsAssertionVerifier,
  ActAsIdentityResolver,
  FirebaseAdminAuthorizer,
  FirebaseTokenVerifier,
  MemoryJtiStore,
  MemoryPacketStore,
  MemoryRateLimiter,
  createAssertionSigners,
  createFakeFirebaseIssuer,
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

async function assertionServices(authorizeAllowed = true): Promise<{
  services: ContextServices;
  audit: RecordingEmitter;
  mint: (overrides?: Parameters<Awaited<ReturnType<typeof createAssertionSigners>>['mintAssertion']>[0]) => Promise<string>;
}> {
  const runtime = createRuntime({ NODE_ENV: 'test', CONTEXT_ALLOW_LOCAL_IDENTITY: 'true' }, configPath);
  const audit = new RecordingEmitter();
  const signers = await createAssertionSigners();
  const verifier = new ActAsAssertionVerifier({ keys: createLocalJWKSet(signers.hub.jwks) });
  const identity = new ActAsIdentityResolver({
    verifier,
    jtiStore: new MemoryJtiStore(undefined, 'test'),
    authorize: {
      authorize: async () => ({ allowed: authorizeAllowed, reason: authorizeAllowed ? 'ok' : 'denied' }),
    } as never,
  });
  const issuer = await createFakeFirebaseIssuer('proba-context-admin');
  const admin = new FirebaseAdminAuthorizer({
    verifier: new FirebaseTokenVerifier({ projectId: issuer.projectId, keys: issuer.keys }),
    policy: {
      allowedEmails: ['viewer@insights.example'],
      allowedEmailDomains: [],
      adminEmails: ['admin@insights.example'],
    },
  });
  void issuer;
  return {
    audit,
    mint: (o) =>
      signers.mintAssertion({
        sub: IDS.user,
        workspaceId: 'seedbed',
        goalId: IDS.goal,
        threadId: IDS.thread,
        ...o,
      }),
    services: {
      ...runtime.services,
      identity,
      admin,
      deps: { ...runtime.services.deps, audit },
      packetStore: new MemoryPacketStore('test'),
      rateLimiter: new MemoryRateLimiter(undefined, 'test'),
    },
  };
}

describe('Phase 3 identity HTTP', () => {
  it('builds with a valid act-as assertion and stores the packet manifest', async () => {
    const ctx = await assertionServices();
    const app = await buildApp({}, ctx.services);
    const token = await ctx.mint({ jti: 'http-jti-1' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/context/build',
      headers: { authorization: `Bearer ${token}` },
      payload: body(),
    });
    expect(res.statusCode).toBe(200);
    const packet = res.json<ContextPacket>();
    const stored = await ctx.services.packetStore.get(packet.packetId);
    expect(stored?.packetHash).toBe(packet.packetHash);
    expect(stored?.manifest).toEqual(packet.manifest);
    expect(stored).not.toHaveProperty('sections');
    await app.close();
  });

  it('rejects expired and wrong-audience assertions on the build route', async () => {
    const ctx = await assertionServices();
    const app = await buildApp({}, ctx.services);
    const expired = await ctx.mint({ iatOffset: -400, expOffset: -50, jti: 'exp-1' });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/context/build',
          headers: { authorization: `Bearer ${expired}` },
          payload: body(),
        })
      ).json().error.code
    ).toBe('act_as_expired');

    const wrongAud = await ctx.mint({ aud: ['proba-audit'], jti: 'aud-1' });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/context/build',
          headers: { 'x-act-as': wrongAud },
          payload: body(),
        })
      ).json().error.code
    ).toBe('act_as_invalid');
    expect(ctx.audit.events.some((e) => e.action === 'auth.denied')).toBe(true);
    await app.close();
  });

  it('rejects a replayed assertion on the build route', async () => {
    const ctx = await assertionServices();
    const app = await buildApp({}, ctx.services);
    const token = await ctx.mint({ jti: 'replay-http' });
    expect(
      (await app.inject({ method: 'POST', url: '/v1/context/build', headers: { authorization: `Bearer ${token}` }, payload: body() }))
        .statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/context/build',
          headers: { authorization: `Bearer ${token}` },
          payload: body(),
        })
      ).json().error.code
    ).toBe('act_as_replayed');
    await app.close();
  });

  it('rejects a user/workspace mismatch between assertion and body', async () => {
    const ctx = await assertionServices();
    const app = await buildApp({}, ctx.services);
    const token = await ctx.mint({ jti: 'mismatch-1' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/context/build',
      headers: { authorization: `Bearer ${token}` },
      payload: body({ userId: '660e8400-e29b-41d4-a716-446655440099' }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('identity_mismatch');
    await app.close();
  });

  it('gives viewers 403 on packet routes and admins the manifest only', async () => {
    const runtime = createRuntime({ NODE_ENV: 'test', CONTEXT_ALLOW_LOCAL_IDENTITY: 'true' }, configPath);
    const audit = new RecordingEmitter();
    const issuer = await createFakeFirebaseIssuer('proba-packets');
    const admin = new FirebaseAdminAuthorizer({
      verifier: new FirebaseTokenVerifier({ projectId: issuer.projectId, keys: issuer.keys }),
      policy: {
        allowedEmails: ['viewer@insights.example'],
        allowedEmailDomains: [],
        adminEmails: ['admin@insights.example'],
      },
    });
    const packetStore = new MemoryPacketStore('test');
    await packetStore.put({
      packetId: IDS.trace,
      packetHash: 'a'.repeat(64),
      workspaceId: 'seedbed',
      userId: IDS.user,
      goalId: IDS.goal,
      stepId: 'step-1',
      configVersion: '1',
      templateVersion: '1',
      manifest: {
        sources: {},
        totals: { returned: 0, included: 0, dropped: 0, gaps: 0, tokens: 0, latencyMs: 0 },
        droppedItemIds: [],
      },
      createdAt: new Date().toISOString(),
    });
    const services: ContextServices = {
      ...runtime.services,
      admin,
      packetStore,
      deps: { ...runtime.services.deps, audit },
      rateLimiter: new MemoryRateLimiter(undefined, 'test'),
    };
    const app = await buildApp({}, services);

    const viewerToken = await issuer.mint({ uid: 'uid-viewer', email: 'viewer@insights.example' });
    const viewer = await app.inject({
      method: 'GET',
      url: `/v1/context/packets/${IDS.trace}`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(viewer.statusCode).toBe(403);
    expect(viewer.json().error.code).toBe('insufficient_role');
    expect(audit.events.some((e) => e.action === 'auth.denied')).toBe(true);

    const adminToken = await issuer.mint({ uid: 'uid-admin', email: 'admin@insights.example' });
    const ok = await app.inject({
      method: 'GET',
      url: `/v1/context/packets/${IDS.trace}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ packetId: IDS.trace, manifest: expect.any(Object) });
    expect(ok.json()).not.toHaveProperty('sections');
    expect(audit.events.some((e) => e.action === 'context.packet_viewed')).toBe(true);

    const list = await app.inject({
      method: 'GET',
      url: `/v1/context/packets?goalId=${IDS.goal}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);

    const viewerList = await app.inject({
      method: 'GET',
      url: `/v1/context/packets?goalId=${IDS.goal}`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(viewerList.statusCode).toBe(403);

    const invalidateViewer = await app.inject({
      method: 'POST',
      url: '/v1/cache/invalidate',
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: { goalId: IDS.goal, workspaceId: 'seedbed' },
    });
    expect(invalidateViewer.statusCode).toBe(403);

    const invalidateAdmin = await app.inject({
      method: 'POST',
      url: '/v1/cache/invalidate',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { goalId: IDS.goal, workspaceId: 'seedbed' },
    });
    expect(invalidateAdmin.statusCode).toBe(200);
    expect(invalidateAdmin.json()).toEqual({ removed: expect.any(Number) });
    expect(audit.events.some((e) => e.action === 'context.cache_invalidated')).toBe(true);

    await app.close();
  });
});

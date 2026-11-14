import { describe, expect, it } from 'vitest';
import { SourceAdapterError } from '../http/errors.js';
import { CANARY } from './__fixtures__/loadContract.js';
import { actingQuery, clientFor, jsonResponse, recordingFetch } from './__fixtures__/harness.js';
import { SELF_MEMORY_SOURCE, SelfMemoryHttpSource } from './selfMemoryHttpSource.js';

const body = {
  version: '2026-11-14.1',
  memories: [
    { id: 'aa0e8400-e29b-41d4-a716-000000000002', key: '02-success', version: '2026-11-14.1', title: 'Success', content: 'A measured campaign.', category: 'semantic', validFrom: '2026-11-14T00:00:00.000Z' },
    { id: 'aa0e8400-e29b-41d4-a716-000000000001', key: '01-identity', version: '2026-11-14.1', title: 'Who Proba is', content: 'I am Proba.', category: 'semantic', validFrom: '2026-11-14T00:00:00.000Z' },
  ],
};

describe('SelfMemoryHttpSource', () => {
  it('reads GET /v1/self as the acting user and maps entries to system-trusted items in key order', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, body));
    const source = new SelfMemoryHttpSource({ client: clientFor('http://memory.test', 'proba-memory', fetchImpl) });
    const items = await source.fetchSelf(actingQuery());
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe('/v1/self');
    expect(calls[0].url.searchParams.get('actorId')).toBe(CANARY.actingUserId);
    expect(calls[0].url.searchParams.get('workspaceId')).toBe(CANARY.workspaceId);
    expect(calls[0].init.headers).toMatchObject({ Authorization: expect.stringMatching(/^Bearer ey/), 'X-Act-As': 'eyJhbGciOiJFZERTQSJ9.act-as-fixture.sig' });
    expect(items.map((i) => i.itemId)).toEqual(['self.01-identity', 'self.02-success']);
    expect(items[0]).toMatchObject({ sourceRef: { source: SELF_MEMORY_SOURCE, id: '01-identity' }, trust: 'system', text: 'Who Proba is: I am Proba.', score: 1 });
    // Belongs to nobody: no workspace or user, so the packet's scope check keeps it for every caller.
    expect(Object.keys(items[0].data as object)).not.toContain('workspaceId');
    expect(Object.keys(items[0].data as object)).not.toContain('userId');
  });

  it('caches the global self memory for its TTL', async () => {
    let t = 0;
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, body));
    const source = new SelfMemoryHttpSource({ client: clientFor('http://memory.test', 'proba-memory', fetchImpl), ttlMs: 1000, now: () => t });
    await source.fetchSelf(actingQuery());
    t = 500;
    await source.fetchSelf(actingQuery({ workspaceId: 'another', userId: 'someone-else' }));
    expect(calls).toHaveLength(1);
    t = 1500;
    await source.fetchSelf(actingQuery());
    expect(calls).toHaveLength(2);
  });

  it('refuses a response that does not match the contract', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(200, { memories: [{ id: 'x' }] }));
    const source = new SelfMemoryHttpSource({ client: clientFor('http://memory.test', 'proba-memory', fetchImpl) });
    await expect(source.fetchSelf(actingQuery())).rejects.toBeInstanceOf(SourceAdapterError);
  });

  it('needs the act-as assertion', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, body));
    const source = new SelfMemoryHttpSource({ client: clientFor('http://memory.test', 'proba-memory', fetchImpl) });
    await expect(source.fetchSelf(actingQuery({ actAsAssertion: undefined }))).rejects.toBeInstanceOf(SourceAdapterError);
    expect(calls).toHaveLength(0);
  });
});

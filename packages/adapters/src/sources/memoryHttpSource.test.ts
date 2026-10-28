import { describe, expect, it } from 'vitest';
import { SourceAdapterError } from '../http/errors.js';
import { CANARY, loadUpstreamContract } from './__fixtures__/loadContract.js';
import { actingQuery, clientFor, jsonResponse, recordingFetch } from './__fixtures__/harness.js';
import { MemoryHttpSource } from './memoryHttpSource.js';

describe('MemoryHttpSource', () => {
  it('maps the upstream search contract fixture to context items', async () => {
    const fixture = loadUpstreamContract('memory', 'search');
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(fixture.response.status, fixture.response.body));
    const source = new MemoryHttpSource({ client: clientFor('http://memory.test', 'proba-memory', fetchImpl) });

    const { items } = await source.search(actingQuery(), 'discount banner countdown timer', 5);

    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe('/v1/memories/search');
    expect(calls[0].init.headers).toMatchObject({
      Authorization: expect.stringMatching(/^Bearer ey/),
      'X-Act-As': 'eyJhbGciOiJFZERTQSJ9.act-as-fixture.sig',
    });
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body.actorId).toBe(CANARY.actingUserId);
    expect(body.workspaceId).toBe(CANARY.workspaceId);

    expect(items).toHaveLength(2);
    expect(items[0].sourceRef).toEqual({ source: 'proba-memory', id: 'aa0e8400-e29b-41d4-a716-000000000001' });
    expect(items[0].trust).toBe('derived');
    expect(items[0].data).toMatchObject({ workspaceId: CANARY.workspaceId, userId: CANARY.actingUserId });
    expect(items.every((i) => !JSON.stringify(i).includes(CANARY.otherUserId))).toBe(true);
  });

  it('maps the profiles contract fixture', async () => {
    const fixture = loadUpstreamContract('memory', 'profiles');
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, fixture.response.body));
    const source = new MemoryHttpSource({ client: clientFor('http://memory.test', 'proba-memory', fetchImpl) });
    const profiles = await source.listProfiles(actingQuery());
    expect(calls[0].url.pathname).toBe('/v1/profiles');
    expect(calls[0].url.searchParams.get('actorId')).toBe(CANARY.actingUserId);
    expect(profiles[0]?.name).toBe('default');
  });

  it('drops canary rows owned by another user or workspace', async () => {
    const fixture = loadUpstreamContract('memory', 'search');
    const body = structuredClone(fixture.response.body) as {
      results: Array<Record<string, unknown>>;
    };
    body.results.push({
      id: 'canary-other-user',
      category: 'semantic',
      content: 'should never appear',
      score: 0.99,
      createdAt: '2026-10-26T12:00:00.000Z',
      ownerActorId: CANARY.otherUserId,
      workspaceId: CANARY.workspaceId,
    });
    body.results.push({
      id: 'canary-other-workspace',
      category: 'semantic',
      content: 'should never appear either',
      score: 0.98,
      createdAt: '2026-10-26T12:00:00.000Z',
      workspaceId: CANARY.otherWorkspaceId,
      userId: CANARY.actingUserId,
    });

    const { fetchImpl } = recordingFetch(() => jsonResponse(200, body));
    const source = new MemoryHttpSource({ client: clientFor('http://memory.test', 'proba-memory', fetchImpl) });
    const { items } = await source.search(actingQuery(), 'q', 10);
    expect(items.map((i) => i.sourceRef.id)).not.toContain('canary-other-user');
    expect(items.map((i) => i.sourceRef.id)).not.toContain('canary-other-workspace');
    expect(items).toHaveLength(2);
  });

  it('turns an invalid response into a source_error', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(200, { results: 'nope' }));
    const source = new MemoryHttpSource({ client: clientFor('http://memory.test', 'proba-memory', fetchImpl) });
    await expect(source.search(actingQuery(), 'q', 5)).rejects.toMatchObject({
      name: 'SourceAdapterError',
      gapCode: 'source_error',
    } satisfies Partial<SourceAdapterError>);
  });
});

import { describe, expect, it } from 'vitest';
import { CANARY, loadUpstreamContract } from './__fixtures__/loadContract.js';
import { actingQuery, clientFor, jsonResponse, recordingFetch } from './__fixtures__/harness.js';
import { ConversationHttpSource } from './conversationHttpSource.js';

describe('ConversationHttpSource', () => {
  it('maps the thread-messages contract with scope params and limit', async () => {
    const fixture = loadUpstreamContract('hub', 'thread-messages');
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, fixture.response.body));
    const source = new ConversationHttpSource({
      client: clientFor('http://hub.test', 'proba-hub', fetchImpl),
    });

    const { items } = await source.fetchRecent(actingQuery(), 20);

    expect(calls[0].url.pathname).toBe(`/v1/internal/threads/${CANARY.threadId}/messages`);
    expect(calls[0].url.searchParams.get('actorId')).toBe(CANARY.actingUserId);
    expect(calls[0].url.searchParams.get('workspaceId')).toBe(CANARY.workspaceId);
    expect(calls[0].url.searchParams.get('goalId')).toBe(CANARY.goalId);
    expect(calls[0].url.searchParams.get('limit')).toBe('20');
    expect(calls[0].url.searchParams.get('cursor')).toBeNull();
    expect(calls[0].init.headers).toMatchObject({
      Authorization: expect.stringMatching(/^Bearer ey/),
      'X-Act-As': expect.any(String),
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      itemId: 'conversation.990e8400-e29b-41d4-a716-446655440099',
      sourceRef: { source: 'hub.thread', id: '990e8400-e29b-41d4-a716-446655440099' },
      trust: 'user',
      text: 'Raise the daily budget to 120 GBP',
      data: {
        workspaceId: CANARY.workspaceId,
        userId: CANARY.actingUserId,
        threadId: CANARY.threadId,
        role: 'user',
      },
    });
  });

  it('forwards cursor on fetchBefore (conversation_before need)', async () => {
    const fixture = loadUpstreamContract('hub', 'thread-messages');
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, fixture.response.body));
    const source = new ConversationHttpSource({
      client: clientFor('http://hub.test', 'proba-hub', fetchImpl),
    });

    await source.fetchBefore(actingQuery(), 'cursor-abc', 8);
    expect(calls[0].url.searchParams.get('cursor')).toBe('cursor-abc');
    expect(calls[0].url.searchParams.get('limit')).toBe('8');
  });

  it('drops canary messages from another user, workspace or thread', async () => {
    const fixture = loadUpstreamContract('hub', 'thread-messages');
    const body = structuredClone(fixture.response.body) as {
      messages: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };
    body.messages.push({
      id: 'canary-other-user',
      threadId: CANARY.threadId,
      role: 'user',
      text: 'should not appear',
      source: 'user',
      createdAt: '2026-10-28T11:00:00.000Z',
      userId: CANARY.otherUserId,
    });
    body.messages.push({
      id: 'canary-other-workspace',
      threadId: CANARY.threadId,
      role: 'user',
      text: 'should not appear',
      source: 'user',
      createdAt: '2026-10-28T11:00:00.000Z',
      workspaceId: CANARY.otherWorkspaceId,
    });
    body.messages.push({
      id: 'canary-other-thread',
      threadId: 'other-thread-00000000-0000-4000-8000-000000000001',
      role: 'user',
      text: 'should not appear',
      source: 'user',
      createdAt: '2026-10-28T11:00:00.000Z',
    });

    const { fetchImpl } = recordingFetch(() => jsonResponse(200, body));
    const source = new ConversationHttpSource({
      client: clientFor('http://hub.test', 'proba-hub', fetchImpl),
    });
    const { items } = await source.fetchRecent(actingQuery(), 20);
    expect(items.map((i) => i.sourceRef.id)).not.toContain('canary-other-user');
    expect(items.map((i) => i.sourceRef.id)).not.toContain('canary-other-workspace');
    expect(items.map((i) => i.sourceRef.id)).not.toContain('canary-other-thread');
    expect(items).toHaveLength(1);
  });

  it('rejects responses that fail schema validation with source_error', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(200, { messages: [{ id: 1 }] }));
    const source = new ConversationHttpSource({
      client: clientFor('http://hub.test', 'proba-hub', fetchImpl),
    });
    await expect(source.fetchRecent(actingQuery(), 5)).rejects.toMatchObject({ gapCode: 'source_error' });
  });
});

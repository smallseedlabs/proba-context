import { describe, expect, it } from 'vitest';
import { CANARY, loadUpstreamContract } from './__fixtures__/loadContract.js';
import { actingQuery, clientFor, jsonResponse, recordingFetch } from './__fixtures__/harness.js';
import { TaskStateHttpSource } from './taskStateHttpSource.js';

describe('TaskStateHttpSource', () => {
  it('maps the goal-state contract with actorId, workspaceId and goalId', async () => {
    const fixture = loadUpstreamContract('hub', 'goal-state');
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, fixture.response.body));
    const source = new TaskStateHttpSource({
      client: clientFor('http://hub.test', 'proba-hub', fetchImpl),
      now: () => new Date('2026-10-28T12:00:00.000Z'),
    });

    const { items } = await source.fetchTaskState(actingQuery());

    expect(calls[0].url.pathname).toBe(`/v1/internal/goals/${CANARY.goalId}/state`);
    expect(calls[0].url.searchParams.get('actorId')).toBe(CANARY.actingUserId);
    expect(calls[0].url.searchParams.get('workspaceId')).toBe(CANARY.workspaceId);
    expect(calls[0].url.searchParams.get('goalId')).toBe(CANARY.goalId);
    expect(calls[0].init.headers).toMatchObject({
      Authorization: expect.stringMatching(/^Bearer ey/),
      'X-Act-As': expect.any(String),
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      itemId: `task.${CANARY.goalId}`,
      sourceRef: { source: 'hub.task', id: CANARY.goalId },
      trust: 'system',
      data: {
        workspaceId: CANARY.workspaceId,
        userId: CANARY.actingUserId,
        goalId: CANARY.goalId,
        threadId: CANARY.threadId,
        status: 'active',
        title: 'Raise daily budget',
      },
    });
  });

  it('drops a goal state that names another user or workspace (scope canary)', async () => {
    const fixture = loadUpstreamContract('hub', 'goal-state');
    const otherUser = structuredClone(fixture.response.body) as Record<string, unknown>;
    otherUser.userId = CANARY.otherUserId;
    const { fetchImpl: fetchOtherUser } = recordingFetch(() => jsonResponse(200, otherUser));
    const sourceOtherUser = new TaskStateHttpSource({
      client: clientFor('http://hub.test', 'proba-hub', fetchOtherUser),
    });
    expect((await sourceOtherUser.fetchTaskState(actingQuery())).items).toEqual([]);

    const otherWs = structuredClone(fixture.response.body) as Record<string, unknown>;
    otherWs.workspaceId = CANARY.otherWorkspaceId;
    const { fetchImpl: fetchOtherWs } = recordingFetch(() => jsonResponse(200, otherWs));
    const sourceOtherWs = new TaskStateHttpSource({
      client: clientFor('http://hub.test', 'proba-hub', fetchOtherWs),
    });
    expect((await sourceOtherWs.fetchTaskState(actingQuery())).items).toEqual([]);
  });

  it('rejects responses that fail schema validation with source_error', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(200, { goalId: 1 }));
    const source = new TaskStateHttpSource({
      client: clientFor('http://hub.test', 'proba-hub', fetchImpl),
    });
    await expect(source.fetchTaskState(actingQuery())).rejects.toMatchObject({ gapCode: 'source_error' });
  });
});

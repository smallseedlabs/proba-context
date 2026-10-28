import { describe, expect, it } from 'vitest';
import { CANARY, loadUpstreamContract } from './__fixtures__/loadContract.js';
import { actingQuery, clientFor, jsonResponse, recordingFetch } from './__fixtures__/harness.js';
import { AuditHttpSource } from './auditHttpSource.js';

describe('AuditHttpSource', () => {
  it('maps the events-list contract with goalId, actionPrefix and since', async () => {
    const fixture = loadUpstreamContract('audit', 'events-list');
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, fixture.response.body));
    const source = new AuditHttpSource({ client: clientFor('http://audit.test', 'proba-audit', fetchImpl) });

    const { items } = await source.fetchRecent(actingQuery(), 10);

    expect(calls[0].url.pathname).toBe('/v1/events');
    expect(calls[0].url.searchParams.get('actorId')).toBe(CANARY.actingUserId);
    expect(calls[0].url.searchParams.get('workspaceId')).toBe(CANARY.workspaceId);
    expect(calls[0].url.searchParams.get('goalId')).toBe(CANARY.goalId);
    expect(calls[0].url.searchParams.get('actionPrefix')).toBe('goal.');
    expect(calls[0].url.searchParams.get('since')).toBeTruthy();
    expect(calls[0].init.headers).toMatchObject({
      Authorization: expect.stringMatching(/^Bearer ey/),
      'X-Act-As': expect.any(String),
    });

    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.data).toMatchObject({ workspaceId: CANARY.workspaceId, userId: CANARY.actingUserId });
      expect(item.data).toHaveProperty('action');
      expect(item).not.toHaveProperty('text');
      expect(JSON.stringify(item)).not.toMatch(/rawText|contentDigest|hasContent/);
    }
  });

  it('maps the trace-get contract to span items without text', async () => {
    const fixture = loadUpstreamContract('audit', 'trace-get');
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, fixture.response.body));
    const source = new AuditHttpSource({ client: clientFor('http://audit.test', 'proba-audit', fetchImpl) });
    const { items } = await source.fetchTrace(actingQuery(), '990e8400-e29b-41d4-a716-446655440004');
    expect(calls[0].url.pathname).toBe('/v1/traces/990e8400-e29b-41d4-a716-446655440004');
    expect(items.length).toBe(2);
    expect(items.every((i) => i.data && typeof i.data === 'object' && 'action' in (i.data as object))).toBe(true);
  });

  it('drops canary events from another user or workspace', async () => {
    const fixture = loadUpstreamContract('audit', 'events-list');
    const body = structuredClone(fixture.response.body) as { events: Array<Record<string, unknown>> };
    body.events.push({
      eventId: 'canary-other-user',
      traceId: 't1',
      workspaceId: CANARY.workspaceId,
      actor: { type: 'user', id: CANARY.otherUserId },
      service: 'hub',
      action: 'goal.updated',
      outcome: 'success',
      occurredAt: '2026-10-25T10:03:00.000Z',
    });
    body.events.push({
      eventId: 'canary-other-workspace',
      traceId: 't2',
      workspaceId: CANARY.otherWorkspaceId,
      actor: { type: 'user', id: CANARY.actingUserId },
      service: 'hub',
      action: 'goal.updated',
      outcome: 'success',
      occurredAt: '2026-10-25T10:03:00.000Z',
    });

    const { fetchImpl } = recordingFetch(() => jsonResponse(200, body));
    const source = new AuditHttpSource({ client: clientFor('http://audit.test', 'proba-audit', fetchImpl) });
    const { items } = await source.fetchRecent(actingQuery(), 20);
    expect(items.map((i) => i.sourceRef.id)).not.toContain('canary-other-user');
    expect(items.map((i) => i.sourceRef.id)).not.toContain('canary-other-workspace');
  });

  it('rejects responses that fail schema validation with source_error', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(200, { events: [{ eventId: 1 }] }));
    const source = new AuditHttpSource({ client: clientFor('http://audit.test', 'proba-audit', fetchImpl) });
    await expect(source.fetchRecent(actingQuery(), 5)).rejects.toMatchObject({ gapCode: 'source_error' });
  });
});

import { describe, expect, it } from 'vitest';
import { CANARY, loadUpstreamContract } from './__fixtures__/loadContract.js';
import { actingQuery, clientFor, jsonResponse, recordingFetch } from './__fixtures__/harness.js';
import { AnalyticsHttpSource } from './analyticsHttpSource.js';

describe('AnalyticsHttpSource', () => {
  it('maps the campaigns contract fixture for overview', async () => {
    const fixture = loadUpstreamContract('audit', 'analytics-campaigns');
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, fixture.response.body));
    const source = new AnalyticsHttpSource({
      client: clientFor('http://audit.test', 'proba-audit', fetchImpl),
      now: () => new Date('2026-10-26T00:00:00.000Z'),
    });

    const { items } = await source.overview(actingQuery(), 10);

    expect(calls[0].url.pathname).toBe('/v1/analytics/campaigns');
    expect(calls[0].url.searchParams.get('actorId')).toBe(CANARY.actingUserId);
    expect(calls[0].url.searchParams.get('workspaceId')).toBe(CANARY.workspaceId);
    expect(items).toHaveLength(1);
    expect(items[0].data).toMatchObject({
      workspaceId: CANARY.workspaceId,
      userId: CANARY.actingUserId,
      campaignId: 'cmp_1001',
      spend: 96.5,
    });
  });

  it('maps the compare contract fixture for analytics_compare needs', async () => {
    const fixture = loadUpstreamContract('audit', 'analytics-compare');
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, fixture.response.body));
    const source = new AnalyticsHttpSource({
      client: clientFor('http://audit.test', 'proba-audit', fetchImpl),
      now: () => new Date('2026-10-26T00:00:00.000Z'),
    });

    const { items } = await source.compare(actingQuery(), {
      kind: 'analytics_compare',
      campaignIds: ['00000000-0000-4000-8000-0000000000aa'],
      metric: 'spend',
      window: '7d',
    });

    expect(calls[0].url.pathname).toBe('/v1/analytics/compare');
    expect(calls[0].url.searchParams.get('campaignId')).toBe('00000000-0000-4000-8000-0000000000aa');
    expect(items).toHaveLength(1);
    expect(items[0].data).toMatchObject({ kind: 'analytics_compare', metric: 'spend', window: '7d' });
  });

  it('maps the summary contract fixture', async () => {
    const fixture = loadUpstreamContract('audit', 'analytics-summary');
    const { fetchImpl } = recordingFetch(() => jsonResponse(200, fixture.response.body));
    const source = new AnalyticsHttpSource({
      client: clientFor('http://audit.test', 'proba-audit', fetchImpl),
      now: () => new Date('2026-10-26T00:00:00.000Z'),
    });
    const { items } = await source.summary(actingQuery(), '7d');
    expect(items[0].data).toMatchObject({ kind: 'analytics_summary', workspaceId: CANARY.workspaceId });
  });

  it('refuses a summary whose workspaceId is a canary other workspace', async () => {
    const fixture = loadUpstreamContract('audit', 'analytics-summary');
    const body = structuredClone(fixture.response.body) as { workspaceId: string };
    body.workspaceId = CANARY.otherWorkspaceId;
    const { fetchImpl } = recordingFetch(() => jsonResponse(200, body));
    const source = new AnalyticsHttpSource({
      client: clientFor('http://audit.test', 'proba-audit', fetchImpl),
      now: () => new Date('2026-10-26T00:00:00.000Z'),
    });
    await expect(source.summary(actingQuery())).rejects.toMatchObject({ gapCode: 'source_error' });
  });
});

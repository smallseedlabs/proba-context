import type { AnalyticsCompareNeed, AnalyticsSource, SourceQuery, SourceResult } from '@smallseedlabs/proba-context-core';
import type { ContextItem } from '@smallseedlabs/proba-protocol';
import { requireActAsAssertion, scopeParams } from '../http/actAs.js';
import type { DownstreamClient } from '../http/downstreamClient.js';
import { SourceAdapterError } from '../http/errors.js';
import {
  analyticsCampaignsResponseSchema,
  analyticsCompareResponseSchema,
  analyticsSummaryResponseSchema,
} from './schemas/audit.js';

const WINDOW_DAYS: Record<string, number> = {
  '1d': 1,
  '7d': 7,
  '14d': 14,
  '30d': 30,
  '90d': 90,
};

export interface AnalyticsHttpSourceOptions {
  client: DownstreamClient;
  /** Soft ceiling on campaign rows. Default 50. */
  maxLimit?: number;
  now?: () => Date;
}

/**
 * `AnalyticsSource` over audit-api analytics reads (`/v1/analytics/campaigns`, `/summary`, `/compare`),
 * scoped by the acting user's `actorId` / `workspaceId`.
 */
export class AnalyticsHttpSource implements AnalyticsSource {
  private readonly maxLimit: number;
  private readonly now: () => Date;

  constructor(private readonly options: AnalyticsHttpSourceOptions) {
    this.maxLimit = options.maxLimit ?? 50;
    this.now = options.now ?? (() => new Date());
  }

  async overview(query: SourceQuery, limit: number): Promise<SourceResult> {
    const actAs = requireActAsAssertion(query);
    const scope = scopeParams(query);
    const { from, to } = windowBounds('7d', this.now());
    const capped = Math.min(Math.max(1, limit), this.maxLimit);

    const response = await this.options.client.request({
      method: 'GET',
      path: '/v1/analytics/campaigns',
      query: {
        actorId: scope.actorId,
        workspaceId: scope.workspaceId,
        from,
        to,
        granularity: 'hour',
        limit: String(capped),
      },
      actAsAssertion: actAs,
      signal: query.signal,
    });

    const parsed = analyticsCampaignsResponseSchema.safeParse(response.json);
    if (!parsed.success) {
      throw new SourceAdapterError('source_error', 'analytics campaigns response failed schema validation.');
    }
    if (parsed.data.workspaceId !== scope.workspaceId) {
      throw new SourceAdapterError('source_error', 'analytics response workspace did not match the acting workspace.');
    }

    const asOf = typeof parsed.data.freshness?.asOf === 'string' ? parsed.data.freshness.asOf : to;
    const items: ContextItem[] = parsed.data.campaigns.slice(0, capped).map((row) => ({
      itemId: `analytics.campaign.${row.platform}.${row.campaignId}`,
      sourceRef: { source: 'proba-audit.analytics', id: `${row.platform}:${row.campaignId}` },
      trust: 'derived',
      observedAt: asOf,
      data: {
        workspaceId: scope.workspaceId,
        userId: scope.actorId,
        kind: 'campaign_metrics',
        window: { from: parsed.data.from, to: parsed.data.to },
        platform: row.platform,
        accountId: row.accountId,
        campaignId: row.campaignId,
        currency: row.currency,
        impressions: row.impressions,
        clicks: row.clicks,
        spend: row.spend,
        conversions: row.conversions,
        ctr: row.ctr,
        cpc: row.cpc,
        cpm: row.cpm,
        cpa: row.cpa,
        roas: row.roas,
      },
    }));

    return { items };
  }

  async compare(query: SourceQuery, need: AnalyticsCompareNeed): Promise<SourceResult> {
    const actAs = requireActAsAssertion(query);
    const scope = scopeParams(query);
    const { from, to } = windowBounds(need.window, this.now());
    const campaignId = need.campaignIds[0];

    const response = await this.options.client.request({
      method: 'GET',
      path: '/v1/analytics/compare',
      query: {
        actorId: scope.actorId,
        workspaceId: scope.workspaceId,
        currentFrom: from,
        currentTo: to,
        granularity: 'day',
        ...(campaignId ? { campaignId } : {}),
      },
      actAsAssertion: actAs,
      signal: query.signal,
    });

    const parsed = analyticsCompareResponseSchema.safeParse(response.json);
    if (!parsed.success) {
      throw new SourceAdapterError('source_error', 'analytics compare response failed schema validation.');
    }
    if (parsed.data.workspaceId !== scope.workspaceId) {
      throw new SourceAdapterError('source_error', 'analytics compare workspace did not match the acting workspace.');
    }

    const asOf = typeof parsed.data.freshness?.asOf === 'string' ? parsed.data.freshness.asOf : to;
    const item: ContextItem = {
      itemId: `analytics.compare.${need.metric}.${need.window}`,
      sourceRef: { source: 'proba-audit.analytics', id: `compare:${need.metric}:${need.window}` },
      trust: 'derived',
      observedAt: asOf,
      data: {
        workspaceId: scope.workspaceId,
        userId: scope.actorId,
        kind: 'analytics_compare',
        metric: need.metric,
        window: need.window,
        campaignIds: need.campaignIds,
        current: parsed.data.current,
        previous: parsed.data.previous,
        comparison: parsed.data.comparison,
      },
    };

    return { items: [item] };
  }

  /** Optional summary read used by contract tests. */
  async summary(query: SourceQuery, window: keyof typeof WINDOW_DAYS = '7d'): Promise<SourceResult> {
    const actAs = requireActAsAssertion(query);
    const scope = scopeParams(query);
    const { from, to } = windowBounds(window, this.now());

    const response = await this.options.client.request({
      method: 'GET',
      path: '/v1/analytics/summary',
      query: {
        actorId: scope.actorId,
        workspaceId: scope.workspaceId,
        from,
        to,
        granularity: 'hour',
      },
      actAsAssertion: actAs,
      signal: query.signal,
    });

    const parsed = analyticsSummaryResponseSchema.safeParse(response.json);
    if (!parsed.success) {
      throw new SourceAdapterError('source_error', 'analytics summary response failed schema validation.');
    }
    if (parsed.data.workspaceId !== scope.workspaceId) {
      throw new SourceAdapterError('source_error', 'analytics summary workspace did not match the acting workspace.');
    }

    const asOf = typeof parsed.data.freshness?.asOf === 'string' ? parsed.data.freshness.asOf : to;
    return {
      items: [
        {
          itemId: `analytics.summary.${window}`,
          sourceRef: { source: 'proba-audit.analytics', id: `summary:${window}` },
          trust: 'derived',
          observedAt: asOf,
          data: {
            workspaceId: scope.workspaceId,
            userId: scope.actorId,
            kind: 'analytics_summary',
            window: { from: parsed.data.from, to: parsed.data.to },
            totals: parsed.data.totals,
            campaigns: parsed.data.campaigns ?? [],
          },
        },
      ],
    };
  }
}

function windowBounds(window: string, now: Date): { from: string; to: string } {
  const days = WINDOW_DAYS[window] ?? 7;
  const to = alignHour(now);
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function alignHour(date: Date): Date {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

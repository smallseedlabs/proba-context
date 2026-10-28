import { z } from 'zod';

const isoDate = z.string().min(1);

const actorSchema = z
  .object({
    type: z.string(),
    id: z.string(),
  })
  .passthrough();

export const auditEventSchema = z
  .object({
    eventId: z.string().min(1),
    traceId: z.string().min(1),
    workspaceId: z.string().min(1),
    actor: actorSchema,
    service: z.string(),
    action: z.string(),
    category: z.string().optional(),
    outcome: z.string().optional(),
    occurredAt: isoDate,
    details: z.record(z.unknown()).optional(),
    spanId: z.string().optional(),
    userId: z.string().optional(),
    goalId: z.string().optional(),
    threadId: z.string().optional(),
    durationMs: z.number().optional(),
    version: z.number().optional(),
    tags: z.array(z.string()).optional(),
    /** Must never reach the packet: refuse if present as raw text. */
    rawText: z.unknown().optional(),
    contentDigest: z.unknown().optional(),
    hasContent: z.unknown().optional(),
  })
  .passthrough();

export const eventsListResponseSchema = z
  .object({
    events: z.array(auditEventSchema),
    nextCursor: z.string().nullable().optional(),
    from: z.string().nullable().optional(),
    to: z.string().nullable().optional(),
    order: z.string().optional(),
    limit: z.number().optional(),
  })
  .passthrough();

const spanNodeSchema: z.ZodType<Record<string, unknown>> = z.lazy(() =>
  z
    .object({
      eventId: z.string(),
      spanId: z.string(),
      action: z.string(),
      service: z.string(),
      category: z.string().optional(),
      outcome: z.string().optional(),
      actor: actorSchema,
      goalId: z.string().optional(),
      threadId: z.string().optional(),
      startedAt: isoDate,
      offsetMs: z.number().optional(),
      durationMs: z.number().optional(),
      subtreeOutcome: z.string().optional(),
      parentSpanId: z.string().optional(),
      children: z.array(spanNodeSchema).optional(),
    })
    .passthrough()
);

export const traceGetResponseSchema = z
  .object({
    traceId: z.string().min(1),
    startedAt: isoDate,
    endedAt: isoDate.optional(),
    durationMs: z.number().optional(),
    eventCount: z.number().optional(),
    outcome: z.string().optional(),
    truncated: z.boolean().optional(),
    roots: z.array(spanNodeSchema),
    related: z
      .object({
        goalIds: z.array(z.string()).optional(),
        threadIds: z.array(z.string()).optional(),
        campaignIds: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const metricsRowSchema = z
  .object({
    currency: z.string(),
    impressions: z.number(),
    clicks: z.number(),
    spend: z.number(),
    conversions: z.number(),
    ctr: z.number().nullable().optional(),
    cpc: z.number().nullable().optional(),
    cpm: z.number().nullable().optional(),
    cpa: z.number().nullable().optional(),
    roas: z.number().nullable().optional(),
    observationCount: z.number().optional(),
  })
  .passthrough();

const campaignRowSchema = metricsRowSchema
  .extend({
    platform: z.string(),
    accountId: z.string(),
    campaignId: z.string(),
  })
  .passthrough();

export const analyticsSummaryResponseSchema = z
  .object({
    workspaceId: z.string().min(1),
    from: isoDate,
    to: isoDate,
    granularity: z.string(),
    totals: z.array(metricsRowSchema),
    series: z.array(metricsRowSchema.extend({ bucket: isoDate }).passthrough()).optional(),
    campaignsTruncated: z.boolean().optional(),
    campaigns: z.array(campaignRowSchema).optional(),
    freshness: z.record(z.unknown()).optional(),
  })
  .passthrough();

export const analyticsCampaignsResponseSchema = z
  .object({
    workspaceId: z.string().min(1),
    from: isoDate,
    to: isoDate,
    granularity: z.string(),
    campaigns: z.array(campaignRowSchema),
    truncated: z.boolean().optional(),
    freshness: z.record(z.unknown()).optional(),
  })
  .passthrough();

const changeSchema = z
  .object({
    current: z.number(),
    previous: z.number(),
    change: z.number(),
    changePct: z.number().nullable(),
  })
  .passthrough();

export const analyticsCompareResponseSchema = z
  .object({
    workspaceId: z.string().min(1),
    granularity: z.string(),
    current: z
      .object({
        from: isoDate,
        to: isoDate,
        totals: z.array(metricsRowSchema),
      })
      .passthrough(),
    previous: z
      .object({
        from: isoDate,
        to: isoDate,
        totals: z.array(metricsRowSchema),
      })
      .passthrough(),
    comparison: z.array(
      z
        .object({
          currency: z.string(),
          impressions: changeSchema.optional(),
          clicks: changeSchema.optional(),
          spend: changeSchema.optional(),
          conversions: changeSchema.optional(),
        })
        .passthrough()
    ),
    freshness: z.record(z.unknown()).optional(),
  })
  .passthrough();

export type AuditEvent = z.infer<typeof auditEventSchema>;
export type EventsListResponse = z.infer<typeof eventsListResponseSchema>;
export type TraceGetResponse = z.infer<typeof traceGetResponseSchema>;
export type AnalyticsSummaryResponse = z.infer<typeof analyticsSummaryResponseSchema>;
export type AnalyticsCampaignsResponse = z.infer<typeof analyticsCampaignsResponseSchema>;
export type AnalyticsCompareResponse = z.infer<typeof analyticsCompareResponseSchema>;

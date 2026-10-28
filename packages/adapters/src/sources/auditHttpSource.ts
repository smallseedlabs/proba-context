import type { AuditHistorySource, SourceQuery, SourceResult } from '@smallseedlabs/proba-context-core';
import type { ContextItem } from '@smallseedlabs/proba-protocol';
import { requireActAsAssertion, scopeParams } from '../http/actAs.js';
import type { DownstreamClient } from '../http/downstreamClient.js';
import { SourceAdapterError } from '../http/errors.js';
import {
  auditEventSchema,
  eventsListResponseSchema,
  traceGetResponseSchema,
  type AuditEvent,
} from './schemas/audit.js';

export interface AuditHttpSourceOptions {
  client: DownstreamClient;
  /** Default action prefix for recent history. Default `goal.`. */
  actionPrefix?: string;
  /** Soft ceiling on list limit (audit-api caps at 100 for events). Default 100. */
  maxLimit?: number;
}

/**
 * `AuditHistorySource` over audit-api: `GET /v1/events` (with `actorId`, `goalId`, `actionPrefix`, `since`)
 * and `GET /v1/traces/{traceId}`. Responses are mapped to action names, outcomes and numbers only (no text).
 */
export class AuditHttpSource implements AuditHistorySource {
  private readonly actionPrefix: string;
  private readonly maxLimit: number;

  constructor(private readonly options: AuditHttpSourceOptions) {
    this.actionPrefix = options.actionPrefix ?? 'goal.';
    this.maxLimit = options.maxLimit ?? 100;
  }

  async fetchRecent(query: SourceQuery, limit: number): Promise<SourceResult> {
    const actAs = requireActAsAssertion(query);
    const scope = scopeParams(query);
    const capped = Math.min(Math.max(1, limit), this.maxLimit);
    const since = sevenDaysAgo(query);

    const response = await this.options.client.request({
      method: 'GET',
      path: '/v1/events',
      query: {
        actorId: scope.actorId,
        workspaceId: scope.workspaceId,
        goalId: query.identity.goalId,
        actionPrefix: this.actionPrefix,
        since,
        limit: String(capped),
      },
      actAsAssertion: actAs,
      signal: query.signal,
    });

    const parsed = eventsListResponseSchema.safeParse(response.json);
    if (!parsed.success) {
      throw new SourceAdapterError('source_error', 'audit events response failed schema validation.');
    }

    const items = parsed.data.events
      .filter((event) => isEventInScope(event, scope))
      .filter((event) => !hasForbiddenTextFields(event))
      .map((event) => toEventItem(event, scope));

    return { items };
  }

  async fetchTrace(query: SourceQuery, traceId: string): Promise<SourceResult> {
    const actAs = requireActAsAssertion(query);
    const scope = scopeParams(query);

    const response = await this.options.client.request({
      method: 'GET',
      path: `/v1/traces/${encodeURIComponent(traceId)}`,
      query: {
        actorId: scope.actorId,
        workspaceId: scope.workspaceId,
      },
      actAsAssertion: actAs,
      signal: query.signal,
    });

    const parsed = traceGetResponseSchema.safeParse(response.json);
    if (!parsed.success) {
      throw new SourceAdapterError('source_error', 'audit trace response failed schema validation.');
    }

    const related = parsed.data.related;
    if (related?.goalIds?.length && !related.goalIds.includes(query.identity.goalId)) {
      // Trace is not about this goal: treat as empty rather than leaking another goal's span tree.
      return { items: [] };
    }

    const spans = flattenSpans(parsed.data.roots);
    const items: ContextItem[] = spans.map((span, index) => {
      const actor = span.actor as { type: string; id: string };
      return {
        itemId: `audit.trace.${parsed.data.traceId}.${span.eventId ?? index}`,
        sourceRef: { source: 'proba-audit', id: String(span.eventId ?? `${parsed.data.traceId}:${index}`) },
        trust: 'derived',
        observedAt: String(span.startedAt),
        data: {
          workspaceId: scope.workspaceId,
          userId: scope.actorId,
          traceId: parsed.data.traceId,
          action: span.action,
          service: span.service,
          outcome: span.outcome ?? parsed.data.outcome,
          actorType: actor.type,
          ...(typeof span.durationMs === 'number' ? { durationMs: span.durationMs } : {}),
          ...(typeof span.goalId === 'string' ? { goalId: span.goalId } : {}),
        },
      };
    });

    return { items };
  }
}

function sevenDaysAgo(query: SourceQuery): string {
  const now = Date.now();
  // Prefer request-side clock only if we had one; use absolute wall time for the query window.
  void query;
  return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isEventInScope(event: AuditEvent, scope: { actorId: string; workspaceId: string }): boolean {
  if (event.workspaceId !== scope.workspaceId) return false;
  if (event.userId !== undefined && event.userId !== scope.actorId) return false;
  if (event.actor.type === 'user' && event.actor.id !== scope.actorId) return false;
  return true;
}

function hasForbiddenTextFields(event: AuditEvent): boolean {
  return event.rawText !== undefined || event.contentDigest !== undefined || event.hasContent !== undefined;
}

function toEventItem(event: AuditEvent, scope: { actorId: string; workspaceId: string }): ContextItem {
  // Re-parse to drop unknown text-bearing fields from `details` we do not forward as free text.
  const checked = auditEventSchema.parse(event);
  const details = sanitizeDetails(checked.details);
  return {
    itemId: `audit.event.${checked.eventId}`,
    sourceRef: { source: 'proba-audit', id: checked.eventId },
    trust: 'derived',
    observedAt: checked.occurredAt,
    data: {
      workspaceId: scope.workspaceId,
      userId: scope.actorId,
      action: checked.action,
      outcome: checked.outcome ?? null,
      service: checked.service,
      category: checked.category ?? null,
      traceId: checked.traceId,
      ...(checked.goalId ? { goalId: checked.goalId } : {}),
      ...(checked.threadId ? { threadId: checked.threadId } : {}),
      ...(typeof checked.durationMs === 'number' ? { durationMs: checked.durationMs } : {}),
      ...(details ? { details } : {}),
    },
  };
}

function sanitizeDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string') continue; // action names / numbers only
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function flattenSpans(roots: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (nodes: readonly Record<string, unknown>[]): void => {
    for (const node of nodes) {
      out.push(node);
      const children = node.children;
      if (Array.isArray(children)) walk(children as Record<string, unknown>[]);
    }
  };
  walk(roots);
  return out;
}

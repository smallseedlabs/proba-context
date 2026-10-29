import type { NeedKind } from '../../config/index.js';
import type {
  NeedCheckResult,
  NeedFetchSources,
  NeedHandler,
  NeedHandlerContext,
} from '../../ports/needs.js';
import type { SourceQuery, SourceResult } from '../../ports/index.js';
import type { ContextNeed } from '../../protocol.js';

const SUGGEST_ALLOWED = 'Ask only for a need kind listed by GET /v1/context/needs for this step.';

function refuse(
  code: 'need_refused_by_policy' | 'need_out_of_limits',
  reason: string,
  suggestedQuestion?: string
): NeedCheckResult {
  return { allowed: false, code, reason, suggestedQuestion: suggestedQuestion ?? SUGGEST_ALLOWED };
}

function baseCheck(ctx: NeedHandlerContext): NeedCheckResult | undefined {
  if (!ctx.policyAllowed) {
    return refuse('need_refused_by_policy', ctx.policyReason ?? 'Policy does not allow this need in this step.');
  }
  if (!ctx.sourceEnabled) {
    return refuse('need_refused_by_policy', 'The mapped source for this need is switched off.');
  }
  return undefined;
}

function limitCheck(limit: number | undefined, ctx: NeedHandlerContext): NeedCheckResult | undefined {
  if (limit === undefined) return undefined;
  const cap = Math.min(ctx.maxItems, ctx.maxItemsPerSource);
  if (limit > cap) {
    return refuse('need_out_of_limits', `A need may ask for at most ${cap} items.`, 'Lower the limit and ask again.');
  }
  return undefined;
}

export const memorySearchHandler: NeedHandler<'memory_search'> = {
  kind: 'memory_search',
  section: 'memory',
  check(need, ctx) {
    return baseCheck(ctx) ?? limitCheck(need.limit, ctx) ?? { allowed: true };
  },
  fetch(need, sources, query) {
    return sources.memory.search(query, need.query, need.limit);
  },
};

export const conversationBeforeHandler: NeedHandler<'conversation_before'> = {
  kind: 'conversation_before',
  section: 'conversation',
  check(need, ctx) {
    return baseCheck(ctx) ?? limitCheck(need.limit, ctx) ?? { allowed: true };
  },
  fetch(need, sources, query) {
    return sources.conversation.fetchBefore(query, need.cursor, need.limit);
  },
};

export const auditTraceHandler: NeedHandler<'audit_trace'> = {
  kind: 'audit_trace',
  section: 'audit_history',
  check(_need, ctx) {
    return baseCheck(ctx) ?? { allowed: true };
  },
  fetch(need, sources, query) {
    return sources.auditHistory.fetchTrace(query, need.traceId);
  },
};

export const analyticsCompareHandler: NeedHandler<'analytics_compare'> = {
  kind: 'analytics_compare',
  section: 'analytics',
  check(need, ctx) {
    const base = baseCheck(ctx);
    if (base) return base;
    const cap = Math.min(ctx.maxItems, ctx.maxItemsPerSource);
    if (need.campaignIds.length > cap) {
      return refuse(
        'need_out_of_limits',
        `An analytics_compare need may name at most ${cap} campaigns.`,
        'Compare fewer campaigns or split the request.'
      );
    }
    const windows = ctx.allowedWindows ?? [];
    if (!windows.includes(need.window)) {
      return refuse(
        'need_out_of_limits',
        `Window "${need.window}" is outside the allowed set (${windows.join(', ')}).`,
        `Ask for one of: ${windows.join(', ')}.`
      );
    }
    return { allowed: true };
  },
  fetch(need, sources, query) {
    return sources.analytics.compare(query, need);
  },
};

/** All registered need handlers keyed by kind. */
export const NEED_HANDLERS: Readonly<Record<NeedKind, NeedHandler>> = {
  memory_search: memorySearchHandler as NeedHandler,
  analytics_compare: analyticsCompareHandler as NeedHandler,
  audit_trace: auditTraceHandler as NeedHandler,
  conversation_before: conversationBeforeHandler as NeedHandler,
};

export function getNeedHandler(kind: NeedKind): NeedHandler {
  return NEED_HANDLERS[kind];
}

/** Run a typed need through its registered handler (used by the planner's fetch jobs). */
export function runNeedFetch(
  need: ContextNeed,
  sources: NeedFetchSources,
  query: SourceQuery
): Promise<SourceResult> {
  switch (need.kind) {
    case 'memory_search':
      return memorySearchHandler.fetch(need, sources, query);
    case 'conversation_before':
      return conversationBeforeHandler.fetch(need, sources, query);
    case 'audit_trace':
      return auditTraceHandler.fetch(need, sources, query);
    case 'analytics_compare':
      return analyticsCompareHandler.fetch(need, sources, query);
  }
}

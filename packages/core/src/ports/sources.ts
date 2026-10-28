import type { ContextNeed } from '@smallseedlabs/proba-protocol';
import type { SourceQuery, SourceResult } from './common.js';

export type AnalyticsCompareNeed = Extract<ContextNeed, { kind: 'analytics_compare' }>;

/** Recent turns of the conversation thread. */
export interface ConversationSource {
  fetchRecent(query: SourceQuery, limit: number): Promise<SourceResult>;
  /** Turns older than `cursor` (the `conversation_before` need). */
  fetchBefore(query: SourceQuery, cursor: string, limit: number): Promise<SourceResult>;
}

/** Goal and task state for the current goal. */
export interface TaskStateSource {
  fetchTaskState(query: SourceQuery): Promise<SourceResult>;
}

/** Long-term memory (proba-memory). */
export interface MemorySource {
  /** Memories relevant to the request, with no explicit query. */
  recall(query: SourceQuery, limit: number): Promise<SourceResult>;
  /** Memories matching free text (the `memory_search` need). */
  search(query: SourceQuery, text: string, limit: number): Promise<SourceResult>;
}

/** Audit trail history (proba-audit). */
export interface AuditHistorySource {
  fetchRecent(query: SourceQuery, limit: number): Promise<SourceResult>;
  /** Events of one trace (the `audit_trace` need). */
  fetchTrace(query: SourceQuery, traceId: string): Promise<SourceResult>;
}

/** Campaign analytics (the `analytics_compare` need). */
export interface AnalyticsSource {
  /** Recent metrics for the goal's campaigns, with no explicit need. Empty when the goal has none. */
  overview(query: SourceQuery, limit: number): Promise<SourceResult>;
  compare(query: SourceQuery, need: AnalyticsCompareNeed): Promise<SourceResult>;
}

/** Policy statements that apply to the step. */
export interface PolicySource {
  fetchPolicy(query: SourceQuery): Promise<SourceResult>;
}

/** Tools the brain may call in the step. */
export interface ToolCatalogSource {
  fetchTools(query: SourceQuery): Promise<SourceResult>;
}

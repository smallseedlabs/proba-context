import type { ContextGap, ContextNeed, ContextSection, SectionKind } from '../protocol.js';
import type { NeedKind } from '../config/schema.js';
import type { SourceQuery, SourceResult } from './common.js';
import type {
  AnalyticsSource,
  AuditHistorySource,
  ConversationSource,
  MemorySource,
} from './sources.js';

/** Source ports a need handler may call (subset of the pipeline sources). */
export interface NeedFetchSources {
  conversation: ConversationSource;
  memory: MemorySource;
  auditHistory: AuditHistorySource;
  analytics: AnalyticsSource;
}

/** Decision of a need handler before any source is called. */
export type NeedCheckResult =
  | { allowed: true }
  | { allowed: false; code: 'need_refused_by_policy' | 'need_out_of_limits'; reason: string; suggestedQuestion?: string };

/**
 * Registered handler for one typed need kind. Maps the need onto a source port call,
 * enforces hard limits from config, and never invents free-form queries.
 */
export interface NeedHandler<K extends NeedKind = NeedKind> {
  readonly kind: K;
  readonly section: SectionKind;
  /** Policy / limit / window checks that run before fetch. */
  check(need: Extract<ContextNeed, { kind: K }>, ctx: NeedHandlerContext): NeedCheckResult;
  /** Builds the source call for an allowed need. */
  fetch(need: Extract<ContextNeed, { kind: K }>, sources: NeedFetchSources, query: SourceQuery): Promise<SourceResult>;
}

export interface NeedHandlerContext {
  stepType: string;
  /** Hard limits for this kind from `config.needs.kinds`. */
  maxItems: number;
  maxTokens: number;
  allowedWindows?: ReadonlyArray<'1d' | '7d' | '14d' | '30d' | '90d'>;
  /** Global items ceiling (`limits.maxItemsPerSource`). */
  maxItemsPerSource: number;
  /** Whether the mapped source is enabled. */
  sourceEnabled: boolean;
  /** Policy decision for this kind in this step. */
  policyAllowed: boolean;
  policyReason?: string;
}

/** State of the hybrid needs loop for one step (template packet + subsequent needs rounds). */
export interface StepRoundRecord {
  /** `workspaceId:userId:goalId:stepId`. */
  key: string;
  workspaceId: string;
  userId: string;
  goalId: string;
  stepId: string;
  /** Needs rounds already served for this step (0 after the template-only packet). */
  roundsUsed: number;
  /** Sections from the latest packet (item text retained only for the next merge round). */
  sections: ContextSection[];
  gaps: ContextGap[];
  /** Budget used for the template packet (before the extra needs share). */
  baseBudgetTokens: number;
  configVersion: string;
  templateVersion: string;
  updatedAt: string;
}

/**
 * Short-lived store of the latest packet sections for a step so a needs round can extend it.
 * Memory adapters are refused in production (same bar as the packet store).
 */
export interface StepRoundStore {
  get(key: string): Promise<StepRoundRecord | undefined>;
  put(record: StepRoundRecord): Promise<void>;
  delete(key: string): Promise<void>;
  close?(): Promise<void>;
}

export function stepRoundKey(ids: {
  workspaceId: string;
  userId: string;
  goalId: string;
  stepId: string;
}): string {
  return `${ids.workspaceId}:${ids.userId}:${ids.goalId}:${ids.stepId}`;
}

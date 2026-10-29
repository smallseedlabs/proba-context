import { createHash } from 'node:crypto';
import type { SectionKind } from '../protocol.js';
import type { ResolvedIdentity } from '../ports/common.js';
import type { ContextRequest } from '../protocol.js';

/** Parts that identify one cached source fetch. Never includes item text. */
export interface CacheKeyParts {
  source: SectionKind;
  workspaceId: string;
  userId: string;
  /** Included for goal-scoped sources; omitted (or `_`) for policy/tools. */
  goalId?: string;
  /** Normalised, stable params for this fetch (need kind, limits, profile, …). */
  params: Record<string, unknown>;
  /** Active context config version. */
  configVersion: string;
  /** Template version for the step, when the fetch is template-driven. */
  templateVersion?: string;
}

const GOAL_SCOPED: ReadonlySet<SectionKind> = new Set([
  'task',
  'conversation',
  'memory',
  'audit_history',
  'analytics',
]);

/** Whether this source's cache key must include goalId (prevents cross-goal reuse). */
export function sourceUsesGoalId(source: SectionKind): boolean {
  return GOAL_SCOPED.has(source);
}

/** Stable JSON: sorted object keys, arrays kept in order, undefined omitted. */
export function canonicalizeCacheParams(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v !== undefined) out[key] = sortKeys(v);
  }
  return out;
}

/**
 * Builds the opaque cache key. Format embeds workspace, user and goal so invalidation can SCAN
 * without decoding the hash, and so a bug that dropped those from the hash still cannot cross scope.
 *
 * `proba:context:src:{workspaceId}:{userId}:{goalOr_}:{source}:{sha256}`
 */
export function buildCacheKey(parts: CacheKeyParts): string {
  const goalPart = sourceUsesGoalId(parts.source) ? (parts.goalId ?? '_') : '_';
  const material = canonicalizeCacheParams({
    source: parts.source,
    workspaceId: parts.workspaceId,
    userId: parts.userId,
    goalId: goalPart === '_' ? undefined : goalPart,
    params: parts.params,
    configVersion: parts.configVersion,
    templateVersion: parts.templateVersion,
  });
  const digest = createHash('sha256').update(material).digest('hex');
  return `proba:context:src:${parts.workspaceId}:${parts.userId}:${goalPart}:${parts.source}:${digest}`;
}

/** Default params for a template (non-need) source fetch. */
export function baseFetchCacheParams(
  identity: ResolvedIdentity,
  request: ContextRequest,
  source: SectionKind
): Record<string, unknown> {
  // stepId is omitted on purpose: the same goal/stepType/thread should reuse a warm entry within TTL.
  return {
    stepType: request.stepType,
    profile: request.profile ?? null,
    needKind: null,
    // Conversation (and needs that page it) are thread-scoped.
    ...(source === 'conversation' ? { threadId: identity.threadId } : {}),
  };
}

/** Params for a need-driven fetch. */
export function needFetchCacheParams(need: { kind: string } & Record<string, unknown>): Record<string, unknown> {
  const { kind, ...rest } = need;
  return { needKind: kind, ...rest };
}

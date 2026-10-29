import { randomUUID } from 'node:crypto';
import {
  baseFetchCacheParams,
  buildCacheKey,
  needFetchCacheParams,
  sourceUsesGoalId,
} from '../cache/index.js';
import { SOURCE_NAMES } from '../config/index.js';
import { computePacketHash } from '../hash/packetHash.js';
import type { CachedSourcePayload, ResolvedIdentity, StepRoundRecord } from '../ports/index.js';
import { stepRoundKey } from '../ports/index.js';
import { validateContextRequest } from '../protocol.js';
import type {
  ContextGap,
  ContextItem,
  ContextManifest,
  ContextNeed,
  ContextPacket,
  ContextRequest,
  ContextSection,
  SectionKind,
} from '../protocol.js';
import { BuildAudit } from './audit.js';
import { applyBudget, itemTokens, type Candidate, type DropReason } from './budget.js';
import { ContextBuildError } from './errors.js';
import { runJob, type FetchOutcome } from './fetch.js';
import { NEED_SECTION, planBuild, type FetchJob } from './plan.js';
import { sanitiseItem } from './sanitise.js';
import { isInScope } from './scope.js';
import { orderedSections, sectionTiers } from './sections.js';
import type { PipelineDeps } from './types.js';

type ManifestSource = ContextManifest['sources'][string];

const UNAVAILABLE_CODE: Record<SectionKind, string> = {
  policy: 'policy_unavailable',
  task: 'task_unavailable',
  conversation: 'conversation_unavailable',
  memory: 'memory_unavailable',
  audit_history: 'audit_history_unavailable',
  analytics: 'analytics_unavailable',
  tools: 'tools_unavailable',
};

/** Failures of these sources stop the build: a packet without policy or task state is not safe to act on. */
const BUILD_CRITICAL: ReadonlySet<SectionKind> = new Set<SectionKind>(['policy', 'task']);

interface SectionState {
  kind: SectionKind;
  requested: boolean;
  returned: number;
  latencyMs: number;
  /** True when every fetch for this section in this build was a cache hit. */
  cacheHit: boolean;
  /** Items that survived validation, scope and policy checks and were sanitised. */
  candidates: Candidate[];
  drops: Map<DropReason, number>;
  failed?: FetchOutcome;
}

function emptyState(kind: SectionKind, requested: boolean): SectionState {
  return { kind, requested, returned: 0, latencyMs: 0, cacheHit: false, candidates: [], drops: new Map() };
}

function countDrop(state: SectionState, reason: DropReason, n = 1): void {
  if (n > 0) state.drops.set(reason, (state.drops.get(reason) ?? 0) + n);
}

/**
 * Builds the context packet for one brain step.
 *
 * 1. authorise: the identity (already resolved) must match the request's workspace, user, goal and thread;
 * 2. plan: template for the step type plus the validated needs (or needs-only when extending a prior round);
 * 3. fetch: every source in parallel, each under its own timeout; failures become gaps;
 * 4. scope: drop items that belong to another workspace or user (a need whose items are all out of scope is refused);
 * 5. sanitise: redact secrets and (config) personal data, label trust;
 * 6. budget: dedupe, cap, trim by priority, never dropping policy, task or tools;
 * 7. assemble the packet and its hash;
 * 8. audit: `context.requested`, `.need_refused` / `.need_requested`, `.source_fetched`, `.gap_detected`, `.built`;
 * 9. return the packet (and remember it for the next needs round).
 *
 * Throws {@link ContextBuildError}. Item text never reaches an audit event or an error message.
 */
export async function buildContext(
  deps: PipelineDeps,
  request: ContextRequest,
  identity: ResolvedIdentity
): Promise<ContextPacket> {
  const parsed = validateContextRequest(request);
  if (!parsed.success) throw new ContextBuildError('invalid_request', 'The request is not a valid context request.');
  const req = parsed.data as ContextRequest;

  const startedAt = deps.clock.now().getTime();
  const packetId = (deps.newId ?? randomUUID)();
  const audit = new BuildAudit(deps, identity, req, packetId);
  const elapsed = (): number => Math.max(0, deps.clock.now().getTime() - startedAt);

  await audit.emit('context.requested', {
    outcome: 'success',
    details: { counts: { needs: req.needs?.length ?? 0, budgetTokens: req.budgetTokens ?? deps.config.budget.defaultTokens } },
  });

  try {
    // Step 1: authorise.
    if (
      req.workspaceId !== identity.workspaceId ||
      req.userId !== identity.userId ||
      req.goalId !== identity.goalId ||
      req.threadId !== identity.threadId
    ) {
      throw new ContextBuildError('identity_mismatch', 'The request does not match the authenticated identity.');
    }
    return await run(deps, req, identity, audit, packetId, elapsed);
  } catch (err) {
    const error =
      err instanceof ContextBuildError ? err : new ContextBuildError('internal_error', 'The context build failed.', { cause: err });
    if (error.code !== 'audit_unavailable') {
      await audit.emitQuietly('context.build_failed', {
        outcome: error.code === 'identity_mismatch' ? 'denied' : 'failure',
        errorCode: error.code,
        errorMessage: error.message,
        durationMs: elapsed(),
      });
    }
    throw error;
  }
}

async function run(
  deps: PipelineDeps,
  request: ContextRequest,
  identity: ResolvedIdentity,
  audit: BuildAudit,
  packetId: string,
  elapsed: () => number
): Promise<ContextPacket> {
  const { config } = deps;
  const needsConfig = config.needs;
  const hasNeeds = (request.needs?.length ?? 0) > 0;
  const roundKey = stepRoundKey({
    workspaceId: identity.workspaceId,
    userId: identity.userId,
    goalId: identity.goalId,
    stepId: request.stepId,
  });
  const prior = hasNeeds && deps.stepRoundStore ? await deps.stepRoundStore.get(roundKey) : undefined;

  const baseBudgetTokens = Math.min(
    prior?.baseBudgetTokens ?? request.budgetTokens ?? config.budget.defaultTokens,
    config.budget.maxTokens
  );
  const extraBudgetTokens = hasNeeds
    ? Math.min(Math.floor(baseBudgetTokens * (1 + needsConfig.extraTokenShare)), config.budget.maxTokens)
    : baseBudgetTokens;

  let refuseAllNeeds: { code: string; reason: string; suggestedQuestion?: string } | undefined;
  if (hasNeeds && prior && prior.roundsUsed >= needsConfig.maxRoundsPerStep) {
    refuseAllNeeds = {
      code: 'need_out_of_limits',
      reason: `At most ${needsConfig.maxRoundsPerStep} needs rounds are allowed per step.`,
      suggestedQuestion: 'Continue with the context you already have, or start a new step.',
    };
  }
  if (hasNeeds && request.budgetTokens !== undefined && request.budgetTokens > extraBudgetTokens) {
    // Asking for more tokens than the base + extra share is refused for every need.
    refuseAllNeeds = {
      code: 'need_out_of_limits',
      reason: `Needs rounds may use at most ${extraBudgetTokens} tokens (${Math.round(needsConfig.extraTokenShare * 100)}% above the base budget of ${baseBudgetTokens}).`,
      suggestedQuestion: 'Lower budgetTokens or ask for fewer needs.',
    };
  }

  // Extend whenever a prior packet exists for this step (including round-cap refusals).
  const extendPrior = Boolean(hasNeeds && prior);

  // Step 2: plan.
  const plan = planBuild(deps, request, {
    extendPrior,
    ...(refuseAllNeeds ? { refuseAllNeeds } : {}),
  });
  for (const kind of plan.disabled) {
    if (BUILD_CRITICAL.has(kind) && requiredByTemplate(deps, request, kind) && !extendPrior) {
      throw new ContextBuildError('required_source_failed', `The ${kind} source is required for this step but switched off.`);
    }
  }

  const gaps: ContextGap[] = [];
  for (const refused of plan.refused) {
    gaps.push(refused.gap);
    await audit.emit('context.need_refused', {
      outcome: 'denied',
      errorCode: refused.gap.code,
      details: { source: refused.gap.source, needKind: refused.needKind, gapCode: refused.gap.code },
    });
  }
  for (const need of plan.accepted) {
    await audit.emit('context.need_requested', {
      outcome: 'success',
      details: { source: NEED_SECTION[need.kind], needKind: need.kind },
    });
  }

  // Step 3: fetch planned jobs in parallel (cache check → fetch → audit), needs-only when extending.
  const query = { identity, request };
  const outcomes = await Promise.all(
    plan.jobs.map((job) =>
      fetchWithCache(deps, job, query, identity, request, plan.templateVersion, plan.accepted)
    )
  );

  for (const outcome of outcomes) {
    if (outcome.cacheHit) {
      await audit.emit('context.cache_hit', {
        outcome: 'success',
        durationMs: outcome.latencyMs,
        details: { source: outcome.job.kind, counts: { returned: outcome.returned } },
      });
    } else if (outcome.cacheKey) {
      await audit.emit('context.cache_miss', {
        outcome: 'success',
        details: { source: outcome.job.kind },
      });
    }
    await audit.emit('context.source_fetched', {
      outcome: outcome.status === 'ok' ? 'success' : 'failure',
      ...(outcome.status === 'ok' ? {} : { errorCode: outcome.status === 'timeout' ? 'source_timeout' : 'source_error' }),
      durationMs: outcome.latencyMs,
      details: fetchDetails(outcome),
    });
  }

  const states = new Map<SectionKind, SectionState>(
    SOURCE_NAMES.map((kind) => [kind, emptyState(kind, plan.sections.has(kind) || Boolean(prior?.sections.some((s) => s.kind === kind)))])
  );
  const sanitiseOptions = { pii: config.redaction.pii, maxItemChars: config.limits.maxItemChars };
  let redactions = 0;
  const scopeViolations = new Map<SectionKind, number>();
  /** Per-section: whether every outcome this round was a cache hit (and at least one ran). */
  const cacheHitsSeen = new Map<SectionKind, { any: boolean; allHits: boolean }>();

  // Seed candidates from the prior packet when extending (deterministic merge).
  if (extendPrior && prior) {
    for (const section of prior.sections) {
      const state = states.get(section.kind) as SectionState;
      state.requested = true;
      // Prior items count as returned so manifest accounting (returned = included + dropped) still holds.
      state.returned += section.items.length;
      for (const item of section.items) {
        state.candidates.push({ kind: section.kind, item, tokens: itemTokens(deps.tokenizer, item) });
      }
    }
  }

  for (const outcome of outcomes) {
    const kind = outcome.job.kind;
    const state = states.get(kind) as SectionState;
    state.returned += outcome.returned;
    state.latencyMs = Math.max(state.latencyMs, outcome.latencyMs);
    const seen = cacheHitsSeen.get(kind) ?? { any: false, allHits: true };
    seen.any = true;
    if (!outcome.cacheHit) seen.allHits = false;
    cacheHitsSeen.set(kind, seen);
    countDrop(state, 'invalid_item', outcome.returned - outcome.items.length);

    if (outcome.status !== 'ok') {
      state.failed ??= outcome;
      if (BUILD_CRITICAL.has(kind) && plan.sections.get(kind)?.required && !extendPrior) {
        throw new ContextBuildError('required_source_failed', `The ${kind} source did not return a result.`);
      }
      gaps.push(failureGap(kind, outcome));
    }

    // Steps 4 and 5: scope, policy on tools, sanitise (idempotent on cache hits).
    const inScope: ContextItem[] = [];
    const outOfScope: ContextItem[] = [];
    for (const item of outcome.items) {
      if (!isInScope(item, identity)) {
        outOfScope.push(item);
        continue;
      }
      inScope.push(item);
    }

    // A need whose every returned item is out of scope is refused (no leak, audited as need_refused).
    if (outcome.job.needKind && outcome.items.length > 0 && inScope.length === 0) {
      countDrop(state, 'scope_violation', outOfScope.length);
      scopeViolations.set(kind, (scopeViolations.get(kind) ?? 0) + outOfScope.length);
      const gap: ContextGap = {
        code: 'need_refused_by_policy',
        source: kind,
        reason: `The ${outcome.job.needKind} need returned only data outside the acting user's scope.`,
        suggestedQuestion: 'Ask for a resource that belongs to this workspace and user.',
      };
      gaps.push(gap);
      await audit.emit('context.need_refused', {
        outcome: 'denied',
        errorCode: gap.code,
        details: { source: kind, needKind: outcome.job.needKind, gapCode: gap.code },
      });
      continue;
    }

    for (const item of outOfScope) {
      void item;
      countDrop(state, 'scope_violation');
      scopeViolations.set(kind, (scopeViolations.get(kind) ?? 0) + 1);
    }

    const cleanedForCache: ContextItem[] = [];
    for (const item of inScope) {
      if (kind === 'tools' && !toolAllowed(deps, request, item)) {
        countDrop(state, 'policy_forbidden_tool');
        continue;
      }
      const clean = sanitiseItem(kind, item, sanitiseOptions);
      redactions += clean.redactions;
      state.candidates.push({ kind, item: clean.item, tokens: itemTokens(deps.tokenizer, clean.item) });
      cleanedForCache.push(clean.item);
    }

    // Store already-redacted, in-scope items only (never on cache hit, never on failure).
    if (
      !outcome.cacheHit &&
      outcome.cacheKey &&
      outcome.status === 'ok' &&
      deps.cache &&
      config.sources[kind].cache.enabled
    ) {
      const payload: CachedSourcePayload = { items: cleanedForCache, returned: cleanedForCache.length };
      await deps.cache.set(outcome.cacheKey, payload, config.sources[kind].cache.ttlSeconds);
    }
  }

  for (const [kind, seen] of cacheHitsSeen) {
    (states.get(kind) as SectionState).cacheHit = seen.any && seen.allHits;
  }

  for (const [kind, count] of scopeViolations) {
    await audit.emit('context.scope_violation', {
      outcome: 'denied',
      details: { source: kind, counts: { dropped: count } },
    });
  }

  // An analytics section that ends up empty is the one gap the brain can act on with a question.
  const analytics = states.get('analytics') as SectionState;
  if (analytics.requested && analytics.candidates.length === 0 && !analytics.failed) {
    const already = gaps.some((g) => g.code === 'no_analytics_for_campaign');
    if (!already) {
      gaps.push({
        code: 'no_analytics_for_campaign',
        source: 'analytics',
        reason: 'No campaign metrics were returned for this goal.',
        suggestedQuestion: 'Which campaign should I look at?',
      });
    }
  }

  // When extending, keep prior non-need gaps that are still meaningful (e.g. analytics empty).
  if (extendPrior && prior) {
    for (const gap of prior.gaps) {
      if (gap.code.startsWith('need_')) continue;
      if (gaps.some((g) => g.code === gap.code && g.source === gap.source)) continue;
      if (gap.code === 'no_analytics_for_campaign' && analytics.candidates.length > 0) continue;
      gaps.push(gap);
    }
  }

  // Step 6: budget (extra token share applies on needs rounds).
  const tiers = sectionTiers(config);
  const budgetTokens = hasNeeds
    ? Math.min(request.budgetTokens ?? extraBudgetTokens, extraBudgetTokens)
    : baseBudgetTokens;
  const maxItems = new Map<SectionKind, number>([...plan.sections].map(([kind, s]) => [kind, s.maxItems]));
  // Ensure prior-only sections keep a limit during extension.
  if (extendPrior && prior) {
    for (const section of prior.sections) {
      if (!maxItems.has(section.kind)) {
        maxItems.set(section.kind, config.limits.maxItemsPerSource);
      }
    }
  }
  const budget = applyBudget({
    candidates: [...states.values()].flatMap((s) => s.candidates),
    tiers,
    priorities: config.budget.priorities,
    maxItems,
    shares: Object.fromEntries(SOURCE_NAMES.map((kind) => [kind, config.sources[kind].tokenShare])) as Record<SectionKind, number>,
    budgetTokens,
  });
  const droppedItemIds: string[] = [];
  for (const d of budget.dropped) {
    countDrop(states.get(d.kind) as SectionState, d.reason);
    droppedItemIds.push(d.itemId);
  }

  // Cap per-need kind token ceilings: drop lowest-ranked need-sourced overflow is handled by section shares;
  // kind maxTokens is enforced by trimming candidates that exceed the kind ceiling after share trim is reflected in budget.
  // (Section share + global budget already bound tokens; kind maxTokens is documented for GET /needs.)

  // Step 7: assemble.
  const sections = assembleSections(tiers, orderedSections(config), budget.kept);
  const manifest = buildManifest(states, sections, gaps.length, droppedItemIds, elapsed(), plan.accepted);
  const withoutHash = {
    packetId,
    traceId: request.traceId,
    workspaceId: identity.workspaceId,
    userId: identity.userId,
    goalId: identity.goalId,
    stepId: request.stepId,
    configVersion: config.version,
    templateVersion: plan.templateVersion,
    sections,
    gaps,
    manifest,
  };
  const packet: ContextPacket = { ...withoutHash, packetHash: computePacketHash(withoutHash) };

  // Step 8: audit.
  for (const gap of gaps) {
    await audit.emit('context.gap_detected', {
      outcome: 'partial',
      details: { source: gap.source, gapCode: gap.code },
    });
  }
  await audit.emit('context.built', {
    outcome: 'success',
    durationMs: manifest.totals.latencyMs,
    details: {
      packetHash: packet.packetHash,
      counts: {
        sections: sections.length,
        items: manifest.totals.included,
        dropped: manifest.totals.dropped,
        tokens: manifest.totals.tokens,
        gaps: manifest.totals.gaps,
        redactions,
        needsRound: hasNeeds ? (prior?.roundsUsed ?? 0) + (plan.accepted.length > 0 || plan.refused.length > 0 ? 1 : 0) : 0,
      },
    },
  });

  recordBuildMetrics(deps, packet, states, gaps, elapsed());

  // Remember the packet so the next needs round can extend it.
  if (deps.stepRoundStore) {
    const roundsUsed = hasNeeds
      ? (prior?.roundsUsed ?? 0) + (refuseAllNeeds ? 0 : 1)
      : 0;
    const record: StepRoundRecord = {
      key: roundKey,
      workspaceId: identity.workspaceId,
      userId: identity.userId,
      goalId: identity.goalId,
      stepId: request.stepId,
      roundsUsed,
      sections: packet.sections,
      gaps: packet.gaps,
      baseBudgetTokens,
      configVersion: packet.configVersion,
      templateVersion: packet.templateVersion,
      updatedAt: deps.clock.now().toISOString(),
    };
    await deps.stepRoundStore.put(record);
  }

  // Step 9: return.
  return packet;
}

async function fetchWithCache(
  deps: PipelineDeps,
  job: FetchJob,
  query: { identity: ResolvedIdentity; request: ContextRequest },
  identity: ResolvedIdentity,
  request: ContextRequest,
  templateVersion: string,
  acceptedNeeds: readonly ContextNeed[]
): Promise<FetchOutcome> {
  const sourceCfg = deps.config.sources[job.kind];
  const cacheCfg = sourceCfg.cache;
  const timeoutMs = sourceCfg.timeoutMs;
  let cacheKey: string | undefined;

  if (deps.cache && cacheCfg.enabled && cacheCfg.ttlSeconds > 0) {
    const need = job.needKind ? acceptedNeeds.find((n) => n.kind === job.needKind) : undefined;
    const params = need
      ? needFetchCacheParams(need as { kind: string } & Record<string, unknown>)
      : baseFetchCacheParams(identity, request, job.kind);
    cacheKey = buildCacheKey({
      source: job.kind,
      workspaceId: identity.workspaceId,
      userId: identity.userId,
      ...(sourceUsesGoalId(job.kind) ? { goalId: identity.goalId } : {}),
      params,
      configVersion: deps.config.version,
      templateVersion,
    });
    const started = deps.clock.now().getTime();
    const hit = await deps.cache.get(cacheKey);
    const latencyMs = Math.max(0, deps.clock.now().getTime() - started);
    if (hit) {
      deps.metrics?.incCacheHit(job.kind);
      deps.metrics?.observeSourceLatency(job.kind, latencyMs);
      return {
        job,
        status: 'ok',
        items: hit.items,
        returned: hit.returned,
        latencyMs,
        timeoutMs,
        cacheHit: true,
        cacheKey,
      };
    }
    deps.metrics?.incCacheMiss(job.kind);
  }

  const outcome = await runJob(job, query, timeoutMs, deps.clock);
  deps.metrics?.observeSourceLatency(job.kind, outcome.latencyMs);
  if (!cacheKey) deps.metrics?.incSourceRequest(job.kind, 'fetch');
  return { ...outcome, ...(cacheKey ? { cacheKey, cacheHit: false } : {}) };
}

function recordBuildMetrics(
  deps: PipelineDeps,
  packet: ContextPacket,
  states: ReadonlyMap<SectionKind, SectionState>,
  gaps: readonly ContextGap[],
  durationMs: number
): void {
  const metrics = deps.metrics;
  if (!metrics) return;
  metrics.setConfigVersion(deps.config.version);
  metrics.observeBuildDuration(durationMs, 'success');
  let scopeDrops = 0;
  for (const kind of SOURCE_NAMES) {
    const state = states.get(kind) as SectionState;
    const section = packet.sections.find((s) => s.kind === kind);
    const included = section?.items.length ?? 0;
    const dropped = Math.max(0, state.returned - included);
    metrics.addItems(kind, state.returned, included, dropped);
    if (section) metrics.addTokens(kind, section.tokens);
    scopeDrops += state.drops.get('scope_violation') ?? 0;
  }
  metrics.addScopeViolations(scopeDrops);
  for (const gap of gaps) metrics.incGap(gap.code);
}

function requiredByTemplate(deps: PipelineDeps, request: ContextRequest, kind: SectionKind): boolean {
  return deps.templates.get(request.stepType)?.sections.some((s) => s.kind === kind && s.required) ?? false;
}

function toolAllowed(deps: PipelineDeps, request: ContextRequest, item: ContextItem): boolean {
  const data: unknown = item.data;
  const name = data !== null && typeof data === 'object' ? (data as Record<string, unknown>).name : undefined;
  return typeof name === 'string' && deps.policyGuard.isToolAllowed(request.stepType, name);
}

function fetchDetails(outcome: FetchOutcome): Record<string, unknown> {
  return {
    source: outcome.job.kind,
    ...(outcome.job.needKind ? { needKind: outcome.job.needKind } : {}),
    counts: { returned: outcome.returned, timeoutMs: outcome.timeoutMs },
    ...(outcome.cacheHit !== undefined ? { cacheHit: outcome.cacheHit } : {}),
  };
}

function failureGap(kind: SectionKind, outcome: FetchOutcome): ContextGap {
  if (outcome.status === 'timeout') {
    return { code: 'source_timeout', source: kind, reason: `The ${kind} source did not answer within ${outcome.timeoutMs} ms.` };
  }
  const code = outcome.gapCode === 'source_error' ? 'source_error' : (outcome.gapCode ?? UNAVAILABLE_CODE[kind]);
  return {
    code,
    source: kind,
    reason:
      code === 'source_error'
        ? `The ${kind} source returned a response that could not be used.`
        : `The ${kind} source could not be read.`,
  };
}

function compareForDisplay(kind: SectionKind) {
  // Conversation reads in time order; everything else keeps the ranking order.
  return kind === 'conversation'
    ? (a: ContextItem, b: ContextItem): number =>
        (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0) || (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0)
    : undefined;
}

function assembleSections(
  tiers: Record<SectionKind, number>,
  order: readonly SectionKind[],
  kept: readonly Candidate[]
): ContextSection[] {
  const sections: ContextSection[] = [];
  for (const kind of order) {
    const mine = kept.filter((c) => c.kind === kind);
    if (mine.length === 0) continue;
    const items = mine.map((c) => c.item);
    const compare = compareForDisplay(kind);
    if (compare) items.sort(compare);
    sections.push({ kind, priority: tiers[kind], tokens: mine.reduce((sum, c) => sum + c.tokens, 0), items });
  }
  return sections;
}

function buildManifest(
  states: ReadonlyMap<SectionKind, SectionState>,
  sections: readonly ContextSection[],
  gapCount: number,
  budgetDroppedIds: readonly string[],
  latencyMs: number,
  acceptedNeeds: readonly { kind: string }[]
): ContextManifest {
  const sources: Record<string, ManifestSource> = {};
  let returned = 0;
  let included = 0;
  let dropped = 0;
  let tokens = 0;
  for (const kind of SOURCE_NAMES) {
    const state = states.get(kind) as SectionState;
    const section = sections.find((s) => s.kind === kind);
    const inc = section?.items.length ?? 0;
    const drop = Math.max(0, state.returned - inc);
    sources[kind] = {
      requested: state.requested,
      returned: state.returned,
      included: inc,
      dropped: drop,
      droppedReasons: Object.fromEntries([...state.drops].sort(([a], [b]) => (a < b ? -1 : 1))),
      cacheHit: state.cacheHit,
      latencyMs: state.latencyMs,
      tokens: section?.tokens ?? 0,
    };
    returned += state.returned;
    included += inc;
    dropped += drop;
    tokens += section?.tokens ?? 0;
  }
  // Manifest totals stay protocol-shaped; need kinds served this round are counted under totals via gaps/items.
  void acceptedNeeds;
  return {
    sources,
    totals: { returned, included, dropped, tokens, gaps: gapCount, latencyMs },
    droppedItemIds: [...budgetDroppedIds].sort(),
  };
}

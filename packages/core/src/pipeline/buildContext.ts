import { randomUUID } from 'node:crypto';
import { SOURCE_NAMES } from '../config/index.js';
import { computePacketHash } from '../hash/packetHash.js';
import type { ResolvedIdentity } from '../ports/index.js';
import { validateContextRequest } from '../protocol.js';
import type {
  ContextGap,
  ContextItem,
  ContextManifest,
  ContextPacket,
  ContextRequest,
  ContextSection,
  SectionKind,
} from '../protocol.js';
import { BuildAudit } from './audit.js';
import { applyBudget, itemTokens, type Candidate, type DropReason } from './budget.js';
import { ContextBuildError } from './errors.js';
import { runJob, type FetchOutcome } from './fetch.js';
import { planBuild } from './plan.js';
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
  /** Items that survived validation, scope and policy checks and were sanitised. */
  candidates: Candidate[];
  drops: Map<DropReason, number>;
  failed?: FetchOutcome;
}

function emptyState(kind: SectionKind, requested: boolean): SectionState {
  return { kind, requested, returned: 0, latencyMs: 0, candidates: [], drops: new Map() };
}

function countDrop(state: SectionState, reason: DropReason, n = 1): void {
  if (n > 0) state.drops.set(reason, (state.drops.get(reason) ?? 0) + n);
}

/**
 * Builds the context packet for one brain step.
 *
 * 1. authorise: the identity (already resolved) must match the request's workspace, user, goal and thread;
 * 2. plan: template for the step type plus the validated needs;
 * 3. fetch: every source in parallel, each under its own timeout; failures become gaps;
 * 4. scope: drop items that belong to another workspace or user;
 * 5. sanitise: redact secrets and (config) personal data, label trust;
 * 6. budget: dedupe, cap, trim by priority, never dropping policy, task or tools;
 * 7. assemble the packet and its hash;
 * 8. audit: `context.requested`, `.source_fetched`, `.gap_detected`, `.built` or `.build_failed`;
 * 9. return the packet.
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

  // Step 2: plan.
  const plan = planBuild(deps, request);
  for (const kind of plan.disabled) {
    if (BUILD_CRITICAL.has(kind) && requiredByTemplate(deps, request, kind)) {
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

  // Step 3: fetch all sources in parallel.
  const query = { identity, request };
  const outcomes = await Promise.all(
    plan.jobs.map((job) => runJob(job, query, config.sources[job.kind].timeoutMs, deps.clock))
  );

  for (const outcome of outcomes) {
    await audit.emit('context.source_fetched', {
      outcome: outcome.status === 'ok' ? 'success' : 'failure',
      ...(outcome.status === 'ok' ? {} : { errorCode: outcome.status === 'timeout' ? 'source_timeout' : 'source_error' }),
      durationMs: outcome.latencyMs,
      details: fetchDetails(outcome),
    });
  }

  const states = new Map<SectionKind, SectionState>(
    SOURCE_NAMES.map((kind) => [kind, emptyState(kind, plan.sections.has(kind))])
  );
  const sanitiseOptions = { pii: config.redaction.pii, maxItemChars: config.limits.maxItemChars };
  let redactions = 0;
  const scopeViolations = new Map<SectionKind, number>();

  for (const outcome of outcomes) {
    const kind = outcome.job.kind;
    const state = states.get(kind) as SectionState;
    state.returned += outcome.returned;
    state.latencyMs = Math.max(state.latencyMs, outcome.latencyMs);
    countDrop(state, 'invalid_item', outcome.returned - outcome.items.length);

    if (outcome.status !== 'ok') {
      state.failed ??= outcome;
      if (BUILD_CRITICAL.has(kind) && plan.sections.get(kind)?.required) {
        throw new ContextBuildError('required_source_failed', `The ${kind} source did not return a result.`);
      }
      gaps.push(failureGap(kind, outcome));
    }

    // Steps 4 and 5: scope, policy on tools, sanitise.
    for (const item of outcome.items) {
      if (!isInScope(item, identity)) {
        countDrop(state, 'scope_violation');
        scopeViolations.set(kind, (scopeViolations.get(kind) ?? 0) + 1);
        continue;
      }
      if (kind === 'tools' && !toolAllowed(deps, request, item)) {
        countDrop(state, 'policy_forbidden_tool');
        continue;
      }
      const clean = sanitiseItem(kind, item, sanitiseOptions);
      redactions += clean.redactions;
      state.candidates.push({ kind, item: clean.item, tokens: itemTokens(deps.tokenizer, clean.item) });
    }
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
    gaps.push({
      code: 'no_analytics_for_campaign',
      source: 'analytics',
      reason: 'No campaign metrics were returned for this goal.',
      suggestedQuestion: 'Which campaign should I look at?',
    });
  }

  // Step 6: budget.
  const tiers = sectionTiers(config);
  const budgetTokens = Math.min(request.budgetTokens ?? config.budget.defaultTokens, config.budget.maxTokens);
  const maxItems = new Map<SectionKind, number>([...plan.sections].map(([kind, s]) => [kind, s.maxItems]));
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

  // Step 7: assemble.
  const sections = assembleSections(tiers, orderedSections(config), budget.kept);
  const manifest = buildManifest(states, sections, gaps.length, droppedItemIds, elapsed());
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
      },
    },
  });

  // Step 9: return.
  return packet;
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
  latencyMs: number
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
      cacheHit: false,
      latencyMs: state.latencyMs,
      tokens: section?.tokens ?? 0,
    };
    returned += state.returned;
    included += inc;
    dropped += drop;
    tokens += section?.tokens ?? 0;
  }
  return {
    sources,
    totals: { returned, included, dropped, tokens, gaps: gapCount, latencyMs },
    droppedItemIds: [...budgetDroppedIds].sort(),
  };
}

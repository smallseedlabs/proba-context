import { SOURCE_NAMES, type NeedKind, type Template } from '../config/index.js';
import type { SourceQuery, SourceResult } from '../ports/index.js';
import type { ContextGap, ContextNeed, ContextRequest, SectionKind } from '../protocol.js';
import { ContextBuildError } from './errors.js';
import type { PipelineDeps } from './types.js';

/** A single call to a source. A section may need several (the base fetch plus one per need). */
export interface FetchJob {
  kind: SectionKind;
  /** Set when the job answers a need. */
  needKind?: NeedKind;
  run(query: SourceQuery): Promise<SourceResult>;
}

export interface PlannedSection {
  kind: SectionKind;
  required: boolean;
  /** Most items the section may carry. */
  maxItems: number;
}

export interface RefusedNeed {
  needKind: NeedKind;
  gap: ContextGap;
}

export interface Plan {
  templateVersion: string;
  /** Sections whose source is enabled and will be called. */
  sections: Map<SectionKind, PlannedSection>;
  /** Template sections the config switched off. */
  disabled: SectionKind[];
  jobs: FetchJob[];
  refused: RefusedNeed[];
}

export const NEED_SECTION: Readonly<Record<NeedKind, SectionKind>> = {
  memory_search: 'memory',
  analytics_compare: 'analytics',
  audit_trace: 'audit_history',
  conversation_before: 'conversation',
};

function needLimit(need: ContextNeed): number | undefined {
  return need.kind === 'memory_search' || need.kind === 'conversation_before' ? need.limit : undefined;
}

function refusal(need: ContextNeed, code: string, reason: string): RefusedNeed {
  return { needKind: need.kind, gap: { code, source: NEED_SECTION[need.kind], reason } };
}

/**
 * Step 2: take the template for the step type, then merge the typed needs into it. A need that policy
 * forbids, that targets a disabled source, or that is over the configured limits is turned into a gap and
 * does not reach a source. A need for a section the template lacks adds that section (optional).
 */
export function planBuild(deps: PipelineDeps, request: ContextRequest): Plan {
  const template: Template | undefined = deps.templates.get(request.stepType);
  if (!template) throw new ContextBuildError('template_missing', `No template for step type "${request.stepType}".`);
  const { config } = deps;
  const { limits } = config;

  const sections = new Map<SectionKind, PlannedSection>();
  const disabled: SectionKind[] = [];
  const base = new Set<SectionKind>();
  for (const section of template.sections) {
    if (!config.sources[section.kind].enabled) {
      disabled.push(section.kind);
      continue;
    }
    sections.set(section.kind, {
      kind: section.kind,
      required: section.required,
      maxItems: Math.min(section.maxItems ?? limits.maxItemsPerSource, limits.maxItemsPerSource),
    });
    base.add(section.kind);
  }

  const refused: RefusedNeed[] = [];
  const needJobs: Array<{ index: number; job: FetchJob }> = [];
  (request.needs ?? []).forEach((need, index) => {
    if (index >= limits.maxNeedsPerRequest) {
      refused.push(refusal(need, 'need_out_of_limits', `At most ${limits.maxNeedsPerRequest} needs are served per request.`));
      return;
    }
    const decision = deps.policyGuard.checkNeed(request.stepType, need.kind);
    if (!decision.allowed) {
      refused.push(refusal(need, 'need_refused_by_policy', decision.reason));
      return;
    }
    const kind = NEED_SECTION[need.kind];
    if (!config.sources[kind].enabled) {
      refused.push(refusal(need, 'need_refused_by_policy', `The ${kind} source is switched off.`));
      return;
    }
    const limit = needLimit(need);
    if (limit !== undefined && limit > limits.maxItemsPerSource) {
      refused.push(refusal(need, 'need_out_of_limits', `A need may ask for at most ${limits.maxItemsPerSource} items.`));
      return;
    }
    const existing = sections.get(kind);
    // Needs may use the full per-source limit, not only the template's share of it.
    sections.set(kind, { kind, required: existing?.required ?? false, maxItems: limits.maxItemsPerSource });
    needJobs.push({ index, job: jobForNeed(deps, need, kind) });
  });

  const jobs: FetchJob[] = [];
  for (const kind of SOURCE_NAMES) {
    const planned = sections.get(kind);
    if (!planned) continue;
    if (base.has(kind)) jobs.push(baseJob(deps, kind, planned.maxItems));
    for (const { job } of needJobs.filter((n) => n.job.kind === kind).sort((a, b) => a.index - b.index)) jobs.push(job);
  }

  return { templateVersion: template.templateVersion, sections, disabled, jobs, refused };
}

function baseJob(deps: PipelineDeps, kind: SectionKind, limit: number): FetchJob {
  const { sources } = deps;
  switch (kind) {
    case 'policy':
      return { kind, run: (q) => sources.policy.fetchPolicy(q) };
    case 'task':
      return { kind, run: (q) => sources.task.fetchTaskState(q) };
    case 'conversation':
      return { kind, run: (q) => sources.conversation.fetchRecent(q, limit) };
    case 'memory':
      return { kind, run: (q) => sources.memory.recall(q, limit) };
    case 'audit_history':
      return { kind, run: (q) => sources.auditHistory.fetchRecent(q, limit) };
    case 'analytics':
      return { kind, run: (q) => sources.analytics.overview(q, limit) };
    case 'tools':
      return { kind, run: (q) => sources.tools.fetchTools(q) };
  }
}

function jobForNeed(deps: PipelineDeps, need: ContextNeed, kind: SectionKind): FetchJob {
  const { sources } = deps;
  switch (need.kind) {
    case 'memory_search':
      return { kind, needKind: need.kind, run: (q) => sources.memory.search(q, need.query, need.limit) };
    case 'conversation_before':
      return { kind, needKind: need.kind, run: (q) => sources.conversation.fetchBefore(q, need.cursor, need.limit) };
    case 'audit_trace':
      return { kind, needKind: need.kind, run: (q) => sources.auditHistory.fetchTrace(q, need.traceId) };
    case 'analytics_compare':
      return { kind, needKind: need.kind, run: (q) => sources.analytics.compare(q, need) };
  }
}

import { SOURCE_NAMES, type NeedKind, type Template } from '../config/index.js';
import type { NeedHandlerContext } from '../ports/needs.js';
import type { SourceQuery, SourceResult } from '../ports/index.js';
import type { ContextGap, ContextNeed, ContextRequest, SectionKind } from '../protocol.js';
import { ContextBuildError } from './errors.js';
import { getNeedHandler, runNeedFetch } from './needs/handlers.js';
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
  /** Sections whose source is enabled and will be called (or extended from a prior packet). */
  sections: Map<SectionKind, PlannedSection>;
  /** Template sections the config switched off. */
  disabled: SectionKind[];
  jobs: FetchJob[];
  refused: RefusedNeed[];
  /** Needs that passed checks and will be fetched. */
  accepted: ContextNeed[];
  /** True when this plan only fetches needs (prior packet sections are merged in). */
  extendPrior: boolean;
}

export const NEED_SECTION: Readonly<Record<NeedKind, SectionKind>> = {
  memory_search: 'memory',
  analytics_compare: 'analytics',
  audit_trace: 'audit_history',
  conversation_before: 'conversation',
};

function refusal(
  need: ContextNeed,
  code: string,
  reason: string,
  suggestedQuestion?: string
): RefusedNeed {
  return {
    needKind: need.kind,
    gap: {
      code,
      source: NEED_SECTION[need.kind],
      reason,
      ...(suggestedQuestion ? { suggestedQuestion } : {}),
    },
  };
}

export interface PlanOptions {
  /** When true, skip template base fetches and only plan need jobs (packet extension round). */
  extendPrior?: boolean;
  /** When set, every need is refused with this gap (round or extra-token cap exceeded). */
  refuseAllNeeds?: { code: string; reason: string; suggestedQuestion?: string };
}

/**
 * Step 2: take the template for the step type, then merge the typed needs into it. A need that policy
 * forbids, that targets a disabled source, or that is over the configured limits is turned into a gap and
 * does not reach a source. A need for a section the template lacks adds that section (optional).
 */
export function planBuild(deps: PipelineDeps, request: ContextRequest, options: PlanOptions = {}): Plan {
  const template: Template | undefined = deps.templates.get(request.stepType);
  if (!template) throw new ContextBuildError('template_missing', `No template for step type "${request.stepType}".`);
  const { config } = deps;
  const { limits, needs: needsConfig } = config;
  const extendPrior = options.extendPrior === true;

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
  const accepted: ContextNeed[] = [];
  const needJobs: Array<{ index: number; job: FetchJob }> = [];

  (request.needs ?? []).forEach((need, index) => {
    if (options.refuseAllNeeds) {
      refused.push(
        refusal(need, options.refuseAllNeeds.code, options.refuseAllNeeds.reason, options.refuseAllNeeds.suggestedQuestion)
      );
      return;
    }
    if (index >= limits.maxNeedsPerRequest) {
      refused.push(
        refusal(
          need,
          'need_out_of_limits',
          `At most ${limits.maxNeedsPerRequest} needs are served per request.`,
          'Ask for fewer needs in this round.'
        )
      );
      return;
    }

    const kindCfg = needsConfig.kinds[need.kind];
    const policy = deps.policyGuard.checkNeed(request.stepType, need.kind);
    const handler = getNeedHandler(need.kind);
    const ctx: NeedHandlerContext = {
      stepType: request.stepType,
      maxItems: kindCfg.maxItems,
      maxTokens: kindCfg.maxTokens,
      ...(kindCfg.allowedWindows ? { allowedWindows: kindCfg.allowedWindows } : {}),
      maxItemsPerSource: limits.maxItemsPerSource,
      sourceEnabled: config.sources[handler.section].enabled,
      policyAllowed: policy.allowed,
      ...(policy.allowed ? {} : { policyReason: policy.reason }),
    };
    const decision = handler.check(need as never, ctx);
    if (!decision.allowed) {
      refused.push(refusal(need, decision.code, decision.reason, decision.suggestedQuestion));
      return;
    }

    const kind = handler.section;
    const existing = sections.get(kind);
    // Needs may use the full per-source / per-kind limit, not only the template's share of it.
    sections.set(kind, {
      kind,
      required: existing?.required ?? false,
      maxItems: Math.min(kindCfg.maxItems, limits.maxItemsPerSource),
    });
    accepted.push(need);
    needJobs.push({
      index,
      job: {
        kind,
        needKind: need.kind,
        run: (q) => runNeedFetch(need, deps.sources, q),
      },
    });
  });

  const jobs: FetchJob[] = [];
  for (const kind of SOURCE_NAMES) {
    const planned = sections.get(kind);
    if (!planned) continue;
    if (!extendPrior && base.has(kind)) jobs.push(baseJob(deps, kind, planned.maxItems));
    for (const { job } of needJobs.filter((n) => n.job.kind === kind).sort((a, b) => a.index - b.index)) {
      jobs.push(job);
    }
  }

  // Extension rounds still expose prior sections in the plan map so budgeting keeps their limits.
  if (extendPrior) {
    for (const kind of SOURCE_NAMES) {
      if (sections.has(kind)) continue;
      // Prior-only sections are added later from the stored packet; mark them if present in template.
      if (base.has(kind) && config.sources[kind].enabled) {
        const section = template.sections.find((s) => s.kind === kind);
        if (section) {
          sections.set(kind, {
            kind,
            required: section.required,
            maxItems: Math.min(section.maxItems ?? limits.maxItemsPerSource, limits.maxItemsPerSource),
          });
        }
      }
    }
  }

  return {
    templateVersion: template.templateVersion,
    sections,
    disabled,
    jobs,
    refused,
    accepted,
    extendPrior,
  };
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

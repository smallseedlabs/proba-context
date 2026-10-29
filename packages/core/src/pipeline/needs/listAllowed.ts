import { NEED_KINDS, type ContextConfig, type NeedKind } from '../../config/index.js';
import type { PolicyGuard } from '../../ports/index.js';
import type { StepType } from '../../protocol.js';
import { NEED_SECTION } from '../plan.js';

/** One need kind the brain may ask for in a step, with its hard limits. */
export interface AllowedNeedKind {
  kind: NeedKind;
  source: (typeof NEED_SECTION)[NeedKind];
  maxItems: number;
  maxTokens: number;
  allowedWindows?: ReadonlyArray<'1d' | '7d' | '14d' | '30d' | '90d'>;
}

/**
 * Need kinds policy allows for `stepType`, minus kinds whose source is switched off,
 * each with the configured hard limits (for `GET /v1/context/needs`).
 */
export function listAllowedNeeds(
  config: ContextConfig,
  policyGuard: PolicyGuard,
  stepType: StepType
): AllowedNeedKind[] {
  const out: AllowedNeedKind[] = [];
  for (const kind of NEED_KINDS) {
    if (!policyGuard.checkNeed(stepType, kind).allowed) continue;
    const section = NEED_SECTION[kind];
    if (!config.sources[section].enabled) continue;
    const kindCfg = config.needs.kinds[kind];
    out.push({
      kind,
      source: section,
      maxItems: Math.min(kindCfg.maxItems, config.limits.maxItemsPerSource),
      maxTokens: kindCfg.maxTokens,
      ...(kindCfg.allowedWindows ? { allowedWindows: kindCfg.allowedWindows } : {}),
    });
  }
  return out;
}

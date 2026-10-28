import type { StepType } from '@smallseedlabs/proba-protocol';

export type NeedDecision = { allowed: true } | { allowed: false; reason: string };

/** Policy decisions the pipeline enforces on top of what the policy source serves. */
export interface PolicyGuard {
  /** Whether the brain may ask for a need of this kind in this step. */
  checkNeed(stepType: StepType, needKind: string): NeedDecision;
  /** Whether a tool may be described to the brain in this step. */
  isToolAllowed(stepType: StepType, toolName: string): boolean;
}

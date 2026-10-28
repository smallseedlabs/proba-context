import { join } from 'node:path';
import {
  loadPolicyFile,
  loadToolsFile,
  type Clock,
  type ContextItem,
  type NeedDecision,
  type PolicyFile,
  type PolicyGuard,
  type PolicySource,
  type SourceQuery,
  type SourceResult,
  type StepType,
  type ToolCatalogSource,
  type ToolsFile,
} from '@smallseedlabs/proba-context-core';

/** Policy statements, tool descriptions and restrictions read from `policy.yaml` and `tools.yaml`. */
export interface ConfigPolicy {
  policy: PolicySource;
  tools: ToolCatalogSource;
  guard: PolicyGuard;
}

export function loadConfigPolicy(configDir: string, clock: Clock): ConfigPolicy {
  const policyFile = loadPolicyFile(join(configDir, 'policy.yaml'));
  const toolsFile = loadToolsFile(join(configDir, 'tools.yaml'));
  const guard = new ConfigPolicyGuard(policyFile);
  return {
    policy: new ConfigPolicySource(policyFile, clock),
    tools: new ConfigToolCatalogSource(toolsFile, guard, clock),
    guard,
  };
}

/** Serves the statements of `policy.yaml` that apply to the step. Items are system-trusted. */
export class ConfigPolicySource implements PolicySource {
  constructor(
    private readonly file: PolicyFile,
    private readonly clock: Clock
  ) {}

  async fetchPolicy(query: SourceQuery): Promise<SourceResult> {
    const observedAt = this.clock.now().toISOString();
    const items: ContextItem[] = this.file.statements
      .filter((s) => s.appliesTo.includes(query.request.stepType))
      .map((s) => ({
        itemId: `policy.${s.id}`,
        sourceRef: { source: 'policy', id: s.id },
        trust: 'system',
        text: s.text,
        observedAt,
      }));
    return { items };
  }
}

/**
 * Serves the tools of `tools.yaml` that apply to the step, minus any tool the policy restricts for it.
 * The restriction is applied here and again in the pipeline, so a tool forbidden by policy cannot reach a packet.
 */
export class ConfigToolCatalogSource implements ToolCatalogSource {
  constructor(
    private readonly file: ToolsFile,
    private readonly guard: PolicyGuard,
    private readonly clock: Clock
  ) {}

  async fetchTools(query: SourceQuery): Promise<SourceResult> {
    const { stepType } = query.request;
    const observedAt = this.clock.now().toISOString();
    const items: ContextItem[] = this.file.tools
      .filter((t) => t.appliesTo.includes(stepType) && this.guard.isToolAllowed(stepType, t.name))
      .map((t) => ({
        itemId: `tool.${t.name}`,
        sourceRef: { source: 'tools', id: t.name },
        trust: 'system',
        text: t.description,
        data: { name: t.name, risk: t.risk },
        observedAt,
      }));
    return { items };
  }
}

/** Policy decisions from `restrictedNeeds` and `restrictedTools` in `policy.yaml`. */
export class ConfigPolicyGuard implements PolicyGuard {
  constructor(private readonly file: PolicyFile) {}

  checkNeed(stepType: StepType, needKind: string): NeedDecision {
    const hit = this.file.restrictedNeeds.find((r) => r.kind === needKind && r.appliesTo.includes(stepType));
    return hit ? { allowed: false, reason: hit.reason } : { allowed: true };
  }

  isToolAllowed(stepType: StepType, toolName: string): boolean {
    return !this.file.restrictedTools.some((r) => r.name === toolName && r.appliesTo.includes(stepType));
  }
}

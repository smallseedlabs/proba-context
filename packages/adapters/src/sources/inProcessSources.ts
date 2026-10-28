import type {
  AnalyticsSource,
  AuditHistorySource,
  Clock,
  ConversationSource,
  MemorySource,
  PipelineSources,
  PolicySource,
  SourceQuery,
  SourceResult,
  TaskStateSource,
  ToolCatalogSource,
} from '@smallseedlabs/proba-context-core';

/**
 * A source that holds no data and always answers with no items. Used for the sources whose backing services
 * (Hub thread, proba-memory, proba-audit, analytics) are not connected yet: the pipeline then reports
 * the gap the template calls for, for example `no_analytics_for_campaign`.
 */
export class FixedEmptySource implements ConversationSource, MemorySource, AuditHistorySource, AnalyticsSource {
  async fetchRecent(): Promise<SourceResult> {
    return { items: [] };
  }
  async fetchBefore(): Promise<SourceResult> {
    return { items: [] };
  }
  async recall(): Promise<SourceResult> {
    return { items: [] };
  }
  async search(): Promise<SourceResult> {
    return { items: [] };
  }
  async fetchTrace(): Promise<SourceResult> {
    return { items: [] };
  }
  async overview(): Promise<SourceResult> {
    return { items: [] };
  }
  async compare(): Promise<SourceResult> {
    return { items: [] };
  }
}

/**
 * Task state that comes from the verified identity alone: the goal and thread the caller acts in.
 * It carries no goal status or budget; a Hub-backed task source replaces it.
 */
export class IdentityTaskSource implements TaskStateSource {
  constructor(private readonly clock: Clock) {}

  async fetchTaskState(query: SourceQuery): Promise<SourceResult> {
    const { identity } = query;
    return {
      items: [
        {
          itemId: `task.${identity.goalId}`,
          sourceRef: { source: 'context.identity', id: identity.goalId },
          trust: 'system',
          data: { goalId: identity.goalId, threadId: identity.threadId, workspaceId: identity.workspaceId, userId: identity.userId },
          observedAt: this.clock.now().toISOString(),
        },
      ],
    };
  }
}

export interface InProcessSourcesOptions {
  policy: PolicySource;
  tools: ToolCatalogSource;
  clock: Clock;
}

/** Policy and tools from the config files, task state from the identity, and no data for the other sources. */
export function createInProcessSources(options: InProcessSourcesOptions): PipelineSources {
  const empty = new FixedEmptySource();
  return {
    policy: options.policy,
    task: new IdentityTaskSource(options.clock),
    conversation: empty,
    memory: empty,
    auditHistory: empty,
    analytics: empty,
    tools: options.tools,
  };
}

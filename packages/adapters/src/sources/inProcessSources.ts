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
 * A source that holds no data and always answers with no items. Used when an HTTP upstream is not
 * configured: the pipeline then reports the gap the template calls for, for example
 * `no_analytics_for_campaign`.
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
 * It carries no goal status or budget; replaced by the Hub HTTP task source when `HUB_BASE_URL` is set.
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
  /** When set (Phase 2), replaces the empty memory source. */
  memory?: MemorySource;
  /** When set (Phase 2), replaces the empty audit history source. */
  auditHistory?: AuditHistorySource;
  /** When set (Phase 2), replaces the empty analytics source. */
  analytics?: AnalyticsSource;
  /** When set (Phase 2 Hub), replaces the empty conversation source. */
  conversation?: ConversationSource;
  /** When set (Phase 2 Hub), replaces the identity-only task source. */
  task?: TaskStateSource;
}

/**
 * Policy and tools from the config files; task/conversation/memory/audit/analytics from Phase-2
 * HTTP adapters when wired, otherwise identity-only task and empty placeholders.
 */
export function createInProcessSources(options: InProcessSourcesOptions): PipelineSources {
  const empty = new FixedEmptySource();
  return {
    policy: options.policy,
    task: options.task ?? new IdentityTaskSource(options.clock),
    conversation: options.conversation ?? empty,
    memory: options.memory ?? empty,
    auditHistory: options.auditHistory ?? empty,
    analytics: options.analytics ?? empty,
    tools: options.tools,
  };
}

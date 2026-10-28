import type { SourceQuery, SourceResult, TaskStateSource } from '@smallseedlabs/proba-context-core';
import type { ContextItem } from '@smallseedlabs/proba-protocol';
import { requireActAsAssertion, scopeParams } from '../http/actAs.js';
import type { DownstreamClient } from '../http/downstreamClient.js';
import { SourceAdapterError } from '../http/errors.js';
import { goalStateResponseSchema, type GoalStateResponse } from './schemas/hub.js';

export interface TaskStateHttpSourceOptions {
  client: DownstreamClient;
  now?: () => Date;
}

/**
 * `TaskStateSource` over Hub `GET /v1/internal/goals/{goalId}/state`.
 * Scope params and path goalId come only from the verified identity.
 */
export class TaskStateHttpSource implements TaskStateSource {
  private readonly now: () => Date;

  constructor(private readonly options: TaskStateHttpSourceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async fetchTaskState(query: SourceQuery): Promise<SourceResult> {
    const actAs = requireActAsAssertion(query);
    const scope = scopeParams(query);
    const goalId = query.identity.goalId;

    const response = await this.options.client.request({
      method: 'GET',
      path: `/v1/internal/goals/${encodeURIComponent(goalId)}/state`,
      query: {
        actorId: scope.actorId,
        workspaceId: scope.workspaceId,
        goalId,
      },
      actAsAssertion: actAs,
      signal: query.signal,
    });

    const parsed = goalStateResponseSchema.safeParse(response.json);
    if (!parsed.success) {
      throw new SourceAdapterError('source_error', 'hub goal state response failed schema validation.');
    }

    if (!isGoalInScope(parsed.data, scope, goalId)) {
      return { items: [] };
    }

    return { items: [toTaskItem(parsed.data, this.now())] };
  }
}

function isGoalInScope(
  state: GoalStateResponse,
  scope: { actorId: string; workspaceId: string },
  goalId: string
): boolean {
  if (state.workspaceId !== scope.workspaceId) return false;
  if (state.userId !== scope.actorId) return false;
  if (state.goalId !== goalId) return false;
  return true;
}

function toTaskItem(state: GoalStateResponse, observedAt: Date): ContextItem {
  return {
    itemId: `task.${state.goalId}`,
    sourceRef: { source: 'hub.task', id: state.goalId },
    trust: 'system',
    observedAt: observedAt.toISOString(),
    data: {
      workspaceId: state.workspaceId,
      userId: state.userId,
      goalId: state.goalId,
      threadId: state.threadId,
      title: state.title,
      status: state.status,
      step: state.step,
      budget: state.budget,
      approvals: state.approvals,
      declines: state.declines,
      campaignIds: state.campaignIds,
    },
  };
}

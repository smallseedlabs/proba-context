import type { ConversationSource, SourceQuery, SourceResult } from '@smallseedlabs/proba-context-core';
import type { ContextItem } from '@smallseedlabs/proba-protocol';
import { requireActAsAssertion, scopeParams } from '../http/actAs.js';
import type { DownstreamClient } from '../http/downstreamClient.js';
import { SourceAdapterError } from '../http/errors.js';
import { threadMessagesResponseSchema, type ThreadMessage } from './schemas/hub.js';

export interface ConversationHttpSourceOptions {
  client: DownstreamClient;
  /** Soft ceiling on page size (Hub caps messages). Default 50. */
  maxLimit?: number;
}

/**
 * `ConversationSource` over Hub `GET /v1/internal/threads/{threadId}/messages`.
 * Scope params and path threadId come only from the verified identity.
 */
export class ConversationHttpSource implements ConversationSource {
  private readonly maxLimit: number;

  constructor(private readonly options: ConversationHttpSourceOptions) {
    this.maxLimit = options.maxLimit ?? 50;
  }

  async fetchRecent(query: SourceQuery, limit: number): Promise<SourceResult> {
    return this.fetchPage(query, limit);
  }

  async fetchBefore(query: SourceQuery, cursor: string, limit: number): Promise<SourceResult> {
    return this.fetchPage(query, limit, cursor);
  }

  private async fetchPage(query: SourceQuery, limit: number, cursor?: string): Promise<SourceResult> {
    const actAs = requireActAsAssertion(query);
    const scope = scopeParams(query);
    const threadId = query.identity.threadId;
    const goalId = query.identity.goalId;
    const capped = Math.min(Math.max(1, limit), this.maxLimit);

    const response = await this.options.client.request({
      method: 'GET',
      path: `/v1/internal/threads/${encodeURIComponent(threadId)}/messages`,
      query: {
        actorId: scope.actorId,
        workspaceId: scope.workspaceId,
        goalId,
        limit: String(capped),
        ...(cursor ? { cursor } : {}),
      },
      actAsAssertion: actAs,
      signal: query.signal,
    });

    const parsed = threadMessagesResponseSchema.safeParse(response.json);
    if (!parsed.success) {
      throw new SourceAdapterError('source_error', 'hub thread messages response failed schema validation.');
    }

    const items = parsed.data.messages
      .filter((msg) => isMessageInScope(msg, scope, threadId))
      .map((msg) => toConversationItem(msg, scope));

    return { items };
  }
}

function isMessageInScope(
  msg: ThreadMessage,
  scope: { actorId: string; workspaceId: string },
  threadId: string
): boolean {
  if (msg.threadId !== threadId) return false;
  if (msg.workspaceId !== undefined && msg.workspaceId !== scope.workspaceId) return false;
  if (msg.userId !== undefined && msg.userId !== scope.actorId) return false;
  return true;
}

function toConversationItem(msg: ThreadMessage, scope: { actorId: string; workspaceId: string }): ContextItem {
  const trust = msg.role === 'user' || msg.source === 'user' ? 'user' : 'derived';
  return {
    itemId: `conversation.${msg.id}`,
    sourceRef: { source: 'hub.thread', id: msg.id },
    trust,
    text: msg.text,
    observedAt: msg.createdAt,
    data: {
      workspaceId: scope.workspaceId,
      userId: scope.actorId,
      threadId: msg.threadId,
      role: msg.role,
      source: msg.source,
    },
  };
}

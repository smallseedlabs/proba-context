import type { MemorySource, SourceQuery, SourceResult } from '@smallseedlabs/proba-context-core';
import type { ContextItem } from '@smallseedlabs/proba-protocol';
import { requireActAsAssertion, scopeParams } from '../http/actAs.js';
import type { DownstreamClient } from '../http/downstreamClient.js';
import { SourceAdapterError } from '../http/errors.js';
import { memoryProfilesResponseSchema, memorySearchResponseSchema, type MemorySearchResult } from './schemas/memory.js';

export interface MemoryHttpSourceOptions {
  client: DownstreamClient;
  /** Soft ceiling on search limit (memory-api caps at 20). Default 20. */
  maxLimit?: number;
}

/**
 * `MemorySource` over memory-api: `POST /v1/memories/search` and `GET /v1/profiles`.
 * Every call carries the bridge service token and forwards `X-Act-As`, with `actorId` /
 * `workspaceId` taken only from the verified identity.
 */
export class MemoryHttpSource implements MemorySource {
  private readonly maxLimit: number;

  constructor(private readonly options: MemoryHttpSourceOptions) {
    this.maxLimit = options.maxLimit ?? 20;
  }

  async recall(query: SourceQuery, limit: number): Promise<SourceResult> {
    const text = query.request.profile?.trim()
      ? `context for ${query.request.stepType}`
      : `context for step ${query.request.stepType}`;
    return this.search(query, text, limit);
  }

  async search(query: SourceQuery, text: string, limit: number): Promise<SourceResult> {
    const actAs = requireActAsAssertion(query);
    const scope = scopeParams(query);
    const capped = Math.min(Math.max(1, limit), this.maxLimit);
    const body: Record<string, unknown> = {
      query: text.slice(0, 500),
      limit: capped,
      actorId: scope.actorId,
      workspaceId: scope.workspaceId,
    };
    if (query.request.profile) body.profile = query.request.profile;

    const response = await this.options.client.request({
      method: 'POST',
      path: '/v1/memories/search',
      body,
      actAsAssertion: actAs,
      signal: query.signal,
    });

    const parsed = memorySearchResponseSchema.safeParse(response.json);
    if (!parsed.success) {
      throw new SourceAdapterError('source_error', 'memory search response failed schema validation.');
    }

    const items = parsed.data.results
      .filter((row) => isMemoryInScope(row, scope))
      .map((row) => toMemoryItem(row, scope));

    return { items };
  }

  /** Lists scoring profiles for the workspace (used by contract tests and optional profile checks). */
  async listProfiles(query: SourceQuery): Promise<{ name: string; version: number; status: string }[]> {
    const actAs = requireActAsAssertion(query);
    const scope = scopeParams(query);
    const response = await this.options.client.request({
      method: 'GET',
      path: '/v1/profiles',
      query: { actorId: scope.actorId, workspaceId: scope.workspaceId },
      actAsAssertion: actAs,
      signal: query.signal,
    });
    const parsed = memoryProfilesResponseSchema.safeParse(response.json);
    if (!parsed.success) {
      throw new SourceAdapterError('source_error', 'memory profiles response failed schema validation.');
    }
    return parsed.data.profiles.map((p) => ({ name: p.name, version: p.version, status: p.status }));
  }
}

function isMemoryInScope(
  row: MemorySearchResult,
  scope: { actorId: string; workspaceId: string }
): boolean {
  if (row.workspaceId !== undefined && row.workspaceId !== scope.workspaceId) return false;
  if (row.userId !== undefined && row.userId !== scope.actorId) return false;
  if (row.ownerActorId !== undefined && row.ownerActorId !== scope.actorId) return false;
  return true;
}

function toMemoryItem(row: MemorySearchResult, scope: { actorId: string; workspaceId: string }): ContextItem {
  const text = (row.summary && row.summary.trim()) || row.content;
  return {
    itemId: `memory.${row.id}`,
    sourceRef: { source: 'proba-memory', id: row.id },
    trust: 'derived',
    text,
    score: row.score,
    observedAt: row.createdAt,
    data: {
      workspaceId: scope.workspaceId,
      userId: scope.actorId,
      category: row.category,
      memoryId: row.id,
      ...(row.importance !== undefined ? { importance: row.importance } : {}),
      ...(row.confidence !== undefined ? { confidence: row.confidence } : {}),
    },
  };
}

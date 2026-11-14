import type { SourceQuery } from '@smallseedlabs/proba-context-core';
import type { ContextItem } from '@smallseedlabs/proba-protocol';
import { z } from 'zod';
import { requireActAsAssertion, scopeParams } from '../http/actAs.js';
import type { DownstreamClient } from '../http/downstreamClient.js';
import { SourceAdapterError } from '../http/errors.js';

/** `source` of every self memory item; the gateway puts these items first in the model's system text. */
export const SELF_MEMORY_SOURCE = 'proba-self';

const selfResponseSchema = z
  .object({
    version: z.string().nullable(),
    memories: z.array(
      z
        .object({
          id: z.string().min(1),
          key: z.string().min(1).max(80),
          version: z.string().min(1),
          title: z.string().min(1),
          content: z.string().min(1),
          category: z.string(),
          validFrom: z.string().min(1),
        })
        .passthrough()
    ),
  })
  .passthrough();

export interface SelfMemoryHttpSourceOptions {
  client: DownstreamClient;
  /** How long the self memory is kept in-process. It is the same for every caller and changes only on a seed version bump. Default 60 s. */
  ttlMs?: number;
  now?: () => number;
}

/**
 * Proba's bootstrap self memory from memory-api `GET /v1/self` (system-owned, identical for every workspace). Called with the bridge
 * token and the caller's act-as assertion like every memory read; the answer is cached briefly in-process because it is global.
 * Items are system-trusted policy statements, ordered by key, and carry no workspace or user (they belong to nobody).
 */
export class SelfMemoryHttpSource {
  private cached: { at: number; items: ContextItem[] } | undefined;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: SelfMemoryHttpSourceOptions) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  async fetchSelf(query: SourceQuery): Promise<ContextItem[]> {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.items;
    const actAs = requireActAsAssertion(query);
    const scope = scopeParams(query);
    const response = await this.options.client.request({
      method: 'GET',
      path: '/v1/self',
      query: { actorId: scope.actorId, workspaceId: scope.workspaceId },
      actAsAssertion: actAs,
      signal: query.signal,
    });
    const parsed = selfResponseSchema.safeParse(response.json);
    if (!parsed.success) throw new SourceAdapterError('source_error', 'self memory response failed schema validation.');
    const memories = [...parsed.data.memories].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    // One timestamp and one score for all entries, so the packet keeps them together and in key order (budget ranks by score,
    // then recency, then item id).
    const observedAt = memories.map((m) => m.validFrom).sort().at(-1) ?? new Date(this.now()).toISOString();
    const items: ContextItem[] = memories.map((m) => ({
      itemId: `self.${m.key}`,
      sourceRef: { source: SELF_MEMORY_SOURCE, id: m.key },
      trust: 'system',
      text: `${m.title}: ${m.content}`,
      score: 1,
      observedAt,
      data: { selfVersion: m.version, key: m.key, memoryId: m.id },
    }));
    this.cached = { at: this.now(), items };
    return items;
  }
}

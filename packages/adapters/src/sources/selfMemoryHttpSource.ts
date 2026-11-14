import { SELF_MEMORY_SOURCE, type SourceQuery } from '@smallseedlabs/proba-context-core';
import type { ContextItem } from '@smallseedlabs/proba-protocol';
import { z } from 'zod';
import { requireActAsAssertion, scopeParams } from '../http/actAs.js';
import type { DownstreamClient } from '../http/downstreamClient.js';
import { SourceAdapterError } from '../http/errors.js';

/** `source` of every self memory item; the gateway puts the core first in the model's system text. */
export { SELF_MEMORY_SOURCE };

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
          /** Absent from a memory-api that predates core/detail: every entry is then treated as core (previous behaviour). */
          tier: z.enum(['core', 'detail']).optional(),
          tags: z.array(z.string().max(80)).max(20).optional(),
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

export interface SelfMemoryItems {
  /** Always-on core: policy-section items (required, never dropped). */
  core: ContextItem[];
  /** Tagged detail entries: memory-section candidates, kept only when relevant to the run and within budget. */
  details: ContextItem[];
}

/**
 * Proba's bootstrap self memory from memory-api `GET /v1/self` (system-owned, identical for every workspace). Called with the bridge
 * token and the caller's act-as assertion like every memory read; the answer is cached briefly in-process because it is global.
 * Items are system-trusted and carry no workspace or user (they belong to nobody). The core item's text is exactly the stored core
 * content, so it is byte-identical for every run of the same seed version (the gateway relies on that for prompt caching).
 */
export class SelfMemoryHttpSource {
  private cached: { at: number; value: SelfMemoryItems } | undefined;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: SelfMemoryHttpSourceOptions) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  /** The core (policy section). */
  async fetchSelf(query: SourceQuery): Promise<ContextItem[]> {
    return (await this.fetchAll(query)).core;
  }

  /** The detail entries (memory section), unscored: the build scores them against the run. */
  async fetchDetails(query: SourceQuery): Promise<ContextItem[]> {
    return (await this.fetchAll(query)).details;
  }

  async fetchAll(query: SourceQuery): Promise<SelfMemoryItems> {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.value;
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
    // One timestamp for all entries, so the packet keeps them together and in key order (budget ranks by score, then recency,
    // then item id).
    const observedAt = memories.map((m) => m.validFrom).sort().at(-1) ?? new Date(this.now()).toISOString();
    const core: ContextItem[] = [];
    const details: ContextItem[] = [];
    for (const m of memories) {
      const tier = m.tier ?? 'core';
      if (tier === 'core') {
        core.push({
          itemId: `self.${m.key}`,
          sourceRef: { source: SELF_MEMORY_SOURCE, id: m.key },
          trust: 'system',
          // A v2 core is the authored summary itself; v1 entries keep their title.
          text: m.tier === 'core' ? m.content : `${m.title}: ${m.content}`,
          score: 1,
          observedAt,
          data: { selfVersion: m.version, key: m.key, memoryId: m.id, tier: 'core' },
        });
      } else {
        details.push({
          itemId: `self.${m.key}`,
          sourceRef: { source: SELF_MEMORY_SOURCE, id: m.key },
          trust: 'system',
          text: `Proba guidance (${m.title}): ${m.content}`,
          score: 0,
          observedAt,
          data: { selfVersion: m.version, key: m.key, memoryId: m.id, tier: 'detail', tags: m.tags ?? [] },
        });
      }
    }
    const value = { core, details };
    this.cached = { at: this.now(), value };
    return value;
  }
}

import type {
  CacheInvalidateFilter,
  CachedSourcePayload,
  Clock,
  ContextCache,
} from '@smallseedlabs/proba-context-core';

/** Thrown when an in-process cache is created in production without an explicit allow. */
export class MemoryContextCacheRefusedError extends Error {
  constructor() {
    super(
      'The in-process context cache is not allowed when NODE_ENV=production unless cacheStore.allowMemoryInProduction is true (each replica keeps its own copy).'
    );
    this.name = 'MemoryContextCacheRefusedError';
  }
}

interface Entry {
  key: string;
  value: CachedSourcePayload;
  expiresAt: number;
  /** For invalidation without parsing the opaque key suffix. */
  workspaceId: string;
  userId: string;
  goalId: string;
  source: string;
}

export interface MemoryContextCacheOptions {
  /** Soft cap across all sources. Default 10_000. */
  maxEntries?: number;
  clock?: Clock;
  /**
   * When `NODE_ENV=production`, construction throws unless this is true
   * (mirrors `cacheStore.allowMemoryInProduction`).
   */
  allowInProduction?: boolean;
  nodeEnv?: string;
}

/**
 * Bounded in-process LRU cache for already-redacted source payloads.
 * Per-replica only: enable in production only when the operator accepts that caveat.
 */
export class MemoryContextCache implements ContextCache {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly clock: Clock;

  constructor(options: MemoryContextCacheOptions = {}) {
    const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
    if (nodeEnv === 'production' && !options.allowInProduction) {
      throw new MemoryContextCacheRefusedError();
    }
    this.maxEntries = options.maxEntries ?? 10_000;
    this.clock = options.clock ?? { now: () => new Date() };
  }

  async get(key: string): Promise<CachedSourcePayload | undefined> {
    const now = this.clock.now().getTime();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    // LRU: re-insert to move to the end.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return clonePayload(entry.value);
  }

  async set(key: string, value: CachedSourcePayload, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    const meta = parseKeyMeta(key);
    const entry: Entry = {
      key,
      value: clonePayload(value),
      expiresAt: this.clock.now().getTime() + ttlSeconds * 1000,
      workspaceId: meta.workspaceId,
      userId: meta.userId,
      goalId: meta.goalId,
      source: meta.source,
    };
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, entry);
    this.evict();
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async invalidate(filter: CacheInvalidateFilter): Promise<number> {
    if (!filter.userId && !filter.goalId && !filter.workspaceId) return 0;
    const now = this.clock.now().getTime();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        removed += 1;
        continue;
      }
      if (filter.workspaceId && entry.workspaceId !== filter.workspaceId) continue;
      if (filter.userId && entry.userId !== filter.userId) continue;
      if (filter.goalId && entry.goalId !== filter.goalId) continue;
      this.entries.delete(key);
      removed += 1;
    }
    return removed;
  }

  async ping(): Promise<void> {
    // Always ready.
  }

  async close(): Promise<void> {
    this.entries.clear();
  }

  /** Test helper: number of live entries. */
  size(): number {
    const now = this.clock.now().getTime();
    let n = 0;
    for (const entry of this.entries.values()) if (entry.expiresAt > now) n += 1;
    return n;
  }

  private evict(): void {
    const now = this.clock.now().getTime();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

function clonePayload(value: CachedSourcePayload): CachedSourcePayload {
  return {
    returned: value.returned,
    items: value.items.map((item) => ({ ...item, sourceRef: { ...item.sourceRef } })),
  };
}

/** Keys are `proba:context:src:{workspaceId}:{userId}:{goalOr_}:{source}:{digest}`. */
function parseKeyMeta(key: string): { workspaceId: string; userId: string; goalId: string; source: string } {
  const parts = key.split(':');
  // proba context src workspace user goal source digest  => indices 0..7
  if (parts.length < 8 || parts[0] !== 'proba' || parts[1] !== 'context' || parts[2] !== 'src') {
    return { workspaceId: '', userId: '', goalId: '', source: '' };
  }
  return {
    workspaceId: parts[3] ?? '',
    userId: parts[4] ?? '',
    goalId: parts[5] ?? '',
    source: parts[6] ?? '',
  };
}

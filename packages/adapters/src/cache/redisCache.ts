import { Redis, type RedisOptions } from 'ioredis';
import type {
  CacheInvalidateFilter,
  CachedSourcePayload,
  ContextCache,
  ContextItem,
} from '@smallseedlabs/proba-context-core';
import { contextItemSchema } from '@smallseedlabs/proba-context-core';

/** Thrown when Redis cache is configured for production without a password. */
export class RedisCachePasswordRequiredError extends Error {
  constructor() {
    super('REDIS_URL must include a password when NODE_ENV=production and the Redis context cache is enabled.');
    this.name = 'RedisCachePasswordRequiredError';
  }
}

export interface RedisContextCacheOptions {
  url: string;
  /** Extra ioredis options (TLS, etc.). */
  redis?: RedisOptions;
  keyPrefix?: string;
  /** Index set TTL floor so orphaned index members expire. Default 7 days. */
  indexTtlSeconds?: number;
  connectTimeoutMs?: number;
  nodeEnv?: string;
}

interface StoredPayload {
  returned: number;
  items: unknown[];
}

/**
 * Redis-backed context cache. Keys embed workspace/user/goal for scoped invalidation via secondary sets.
 * Production refuses a passwordless Redis URL.
 */
export class RedisContextCache implements ContextCache {
  private readonly client: Redis;
  private readonly prefix: string;
  private readonly indexTtlSeconds: number;

  constructor(options: RedisContextCacheOptions) {
    const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
    assertRedisPassword(options.url, nodeEnv);
    this.prefix = options.keyPrefix ?? 'proba:context:cache:';
    this.indexTtlSeconds = options.indexTtlSeconds ?? 7 * 24 * 3600;
    this.client = new Redis(options.url, {
      maxRetriesPerRequest: 1,
      connectTimeout: options.connectTimeoutMs ?? 2000,
      enableOfflineQueue: false,
      lazyConnect: true,
      ...options.redis,
      ...tlsOptionsFromUrl(options.url, options.redis),
    });
    this.client.on('error', () => undefined);
  }

  async get(key: string): Promise<CachedSourcePayload | undefined> {
    await this.ensureConnected();
    const raw = await this.client.get(this.dataKey(key));
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as StoredPayload;
      if (!parsed || !Array.isArray(parsed.items) || typeof parsed.returned !== 'number') return undefined;
      const items: ContextItem[] = [];
      for (const candidate of parsed.items) {
        const result = contextItemSchema.safeParse(candidate);
        if (result.success) items.push(result.data as ContextItem);
      }
      return { returned: parsed.returned, items };
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: CachedSourcePayload, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    await this.ensureConnected();
    const meta = parseKeyMeta(key);
    const payload: StoredPayload = { returned: value.returned, items: value.items };
    const dataKey = this.dataKey(key);
    const pipe = this.client.pipeline();
    pipe.set(dataKey, JSON.stringify(payload), 'EX', ttlSeconds);
    const indexTtl = Math.max(ttlSeconds, this.indexTtlSeconds);
    if (meta.userId) {
      const userIdx = this.userIndex(meta.workspaceId, meta.userId);
      pipe.sadd(userIdx, key);
      pipe.expire(userIdx, indexTtl);
    }
    if (meta.goalId && meta.goalId !== '_') {
      const goalIdx = this.goalIndex(meta.workspaceId, meta.goalId);
      pipe.sadd(goalIdx, key);
      pipe.expire(goalIdx, indexTtl);
    }
    await pipe.exec();
  }

  async delete(key: string): Promise<void> {
    await this.ensureConnected();
    await this.client.del(this.dataKey(key));
  }

  async invalidate(filter: CacheInvalidateFilter): Promise<number> {
    if (!filter.userId && !filter.goalId) return 0;
    await this.ensureConnected();
    const workspaceId = filter.workspaceId ?? '*';
    const keys = new Set<string>();
    if (filter.userId) {
      if (workspaceId === '*') {
        // Without a workspace, SCAN user indexes is too broad; require workspaceId for Redis.
        // Fall back to pattern delete on the data key namespace.
        await this.scanDelete(`*:${filter.userId}:*`, keys);
      } else {
        const members = await this.client.smembers(this.userIndex(workspaceId, filter.userId));
        for (const m of members) keys.add(m);
      }
    }
    if (filter.goalId) {
      if (workspaceId === '*') {
        await this.scanDelete(`*:*:${filter.goalId}:*`, keys);
      } else {
        const members = await this.client.smembers(this.goalIndex(workspaceId, filter.goalId));
        for (const m of members) keys.add(m);
      }
    }
    if (keys.size === 0) return 0;
    const pipe = this.client.pipeline();
    for (const key of keys) pipe.del(this.dataKey(key));
    if (filter.userId && workspaceId !== '*') pipe.del(this.userIndex(workspaceId, filter.userId));
    if (filter.goalId && workspaceId !== '*') pipe.del(this.goalIndex(workspaceId, filter.goalId));
    await pipe.exec();
    return keys.size;
  }

  async ping(): Promise<void> {
    await this.ensureConnected();
    const pong = await this.client.ping();
    if (pong !== 'PONG') throw new Error('Redis cache ping failed');
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }

  private dataKey(logicalKey: string): string {
    return `${this.prefix}data:${logicalKey}`;
  }

  private userIndex(workspaceId: string, userId: string): string {
    return `${this.prefix}idx:user:${workspaceId}:${userId}`;
  }

  private goalIndex(workspaceId: string, goalId: string): string {
    return `${this.prefix}idx:goal:${workspaceId}:${goalId}`;
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.status !== 'ready') await this.client.connect();
  }

  private async scanDelete(patternSuffix: string, into: Set<string>): Promise<void> {
    const match = `${this.prefix}data:proba:context:src:${patternSuffix}`;
    let cursor = '0';
    do {
      const [next, found] = await this.client.scan(cursor, 'MATCH', match, 'COUNT', 100);
      cursor = next;
      for (const full of found) {
        const logical = full.slice(`${this.prefix}data:`.length);
        into.add(logical);
      }
    } while (cursor !== '0');
  }
}

/** Refuse production without a password in the Redis URL. */
export function assertRedisPassword(url: string, nodeEnv: string | undefined): void {
  if (nodeEnv !== 'production') return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RedisCachePasswordRequiredError();
  }
  if (!parsed.password) throw new RedisCachePasswordRequiredError();
}

/** Enable TLS when the URL is `rediss://` or `REDIS_TLS` is set via caller-supplied options. */
export function tlsOptionsFromUrl(url: string, existing?: RedisOptions): RedisOptions {
  if (existing?.tls) return {};
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'rediss:') {
      return { tls: { rejectUnauthorized: process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== '0' } };
    }
  } catch {
    // ignore
  }
  if (process.env.REDIS_TLS === '1' || process.env.REDIS_TLS === 'true') {
    return { tls: { rejectUnauthorized: process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== '0' } };
  }
  return {};
}

function parseKeyMeta(key: string): { workspaceId: string; userId: string; goalId: string; source: string } {
  const parts = key.split(':');
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

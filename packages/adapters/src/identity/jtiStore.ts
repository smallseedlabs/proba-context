import { Redis } from 'ioredis';
import type { Clock, JtiStore } from '@smallseedlabs/proba-context-core';

/** Thrown when an in-memory jti store is created in production. */
export class MemoryJtiStoreRefusedError extends Error {
  constructor() {
    super('The in-memory jti store is not allowed when NODE_ENV=production: use Redis.');
    this.name = 'MemoryJtiStoreRefusedError';
  }
}

/**
 * In-process jti store for workstations and automated checks. Refused in production.
 */
export class MemoryJtiStore implements JtiStore {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly clock: Clock = { now: () => new Date() },
    nodeEnv: string | undefined = process.env.NODE_ENV
  ) {
    if (nodeEnv === 'production') throw new MemoryJtiStoreRefusedError();
  }

  async claim(jti: string, ttlSeconds: number): Promise<boolean> {
    const now = this.clock.now().getTime();
    this.sweep(now);
    const existing = this.entries.get(jti);
    if (existing !== undefined && existing > now) return false;
    this.entries.set(jti, now + Math.max(1, ttlSeconds) * 1000);
    return true;
  }

  async close(): Promise<void> {
    this.entries.clear();
  }

  private sweep(now: number): void {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(key);
    }
  }
}

export interface RedisJtiStoreOptions {
  url: string;
  keyPrefix?: string;
  connectTimeoutMs?: number;
}

/**
 * Redis jti store: `SET key 1 NX EX ttl`. Shared across replicas.
 */
export class RedisJtiStore implements JtiStore {
  private readonly client: Redis;
  private readonly prefix: string;

  constructor(options: RedisJtiStoreOptions) {
    this.prefix = options.keyPrefix ?? 'proba:context:jti:';
    this.client = new Redis(options.url, {
      maxRetriesPerRequest: 1,
      connectTimeout: options.connectTimeoutMs ?? 2000,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
  }

  async claim(jti: string, ttlSeconds: number): Promise<boolean> {
    if (this.client.status !== 'ready') await this.client.connect();
    const result = await this.client.set(`${this.prefix}${jti}`, '1', 'EX', Math.max(1, ttlSeconds), 'NX');
    return result === 'OK';
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}

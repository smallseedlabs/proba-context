import { Redis } from 'ioredis';
import type { Clock, StepRoundRecord, StepRoundStore } from '@smallseedlabs/proba-context-core';

/** Thrown when an in-memory step-round store is created in production. */
export class MemoryStepRoundStoreRefusedError extends Error {
  constructor() {
    super('The in-memory step-round store is not allowed when NODE_ENV=production: use Redis.');
    this.name = 'MemoryStepRoundStoreRefusedError';
  }
}

/**
 * In-process store of the latest packet sections per step for the hybrid needs loop.
 * Refused in production.
 */
export class MemoryStepRoundStore implements StepRoundStore {
  private readonly byKey = new Map<string, StepRoundRecord>();

  constructor(nodeEnv: string | undefined = process.env.NODE_ENV) {
    if (nodeEnv === 'production') throw new MemoryStepRoundStoreRefusedError();
  }

  async get(key: string): Promise<StepRoundRecord | undefined> {
    return this.byKey.get(key);
  }

  async put(record: StepRoundRecord): Promise<void> {
    this.byKey.set(record.key, record);
  }

  async delete(key: string): Promise<void> {
    this.byKey.delete(key);
  }

  async close(): Promise<void> {
    this.byKey.clear();
  }
}

export interface RedisStepRoundStoreOptions {
  url: string;
  keyPrefix?: string;
  /** How long step-round state is retained (seconds). Default 1 hour. */
  ttlSeconds?: number;
  clock?: Clock;
}

/**
 * Redis-backed step-round store so needs rounds can extend the prior packet across instances.
 */
export class RedisStepRoundStore implements StepRoundStore {
  private readonly client: Redis;
  private readonly prefix: string;
  private readonly ttlSeconds: number;

  constructor(options: RedisStepRoundStoreOptions) {
    this.prefix = options.keyPrefix ?? 'proba:context:step-round:';
    this.ttlSeconds = options.ttlSeconds ?? 60 * 60;
    this.client = new Redis(options.url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
  }

  async get(key: string): Promise<StepRoundRecord | undefined> {
    if (this.client.status !== 'ready') await this.client.connect();
    const raw = await this.client.get(`${this.prefix}${key}`);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as StepRoundRecord;
    } catch {
      return undefined;
    }
  }

  async put(record: StepRoundRecord): Promise<void> {
    if (this.client.status !== 'ready') await this.client.connect();
    await this.client.set(`${this.prefix}${record.key}`, JSON.stringify(record), 'EX', this.ttlSeconds);
  }

  async delete(key: string): Promise<void> {
    if (this.client.status !== 'ready') await this.client.connect();
    await this.client.del(`${this.prefix}${key}`);
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}

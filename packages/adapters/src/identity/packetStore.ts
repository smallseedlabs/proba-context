import { Redis } from 'ioredis';
import type { Clock, PacketRecord, PacketStore } from '@smallseedlabs/proba-context-core';

/** Thrown when an in-memory packet store is created in production. */
export class MemoryPacketStoreRefusedError extends Error {
  constructor() {
    super('The in-memory packet store is not allowed when NODE_ENV=production: use Redis.');
    this.name = 'MemoryPacketStoreRefusedError';
  }
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/**
 * In-process packet manifest store. Refused in production.
 */
export class MemoryPacketStore implements PacketStore {
  private readonly byId = new Map<string, PacketRecord>();
  private readonly byGoal = new Map<string, string[]>();

  constructor(nodeEnv: string | undefined = process.env.NODE_ENV) {
    if (nodeEnv === 'production') throw new MemoryPacketStoreRefusedError();
  }

  async put(record: PacketRecord): Promise<void> {
    this.byId.set(record.packetId, record);
    const list = this.byGoal.get(record.goalId) ?? [];
    list.unshift(record.packetId);
    this.byGoal.set(record.goalId, list);
  }

  async get(packetId: string): Promise<PacketRecord | undefined> {
    return this.byId.get(packetId);
  }

  async listByGoal(
    goalId: string,
    options: { limit?: number; cursor?: string } = {}
  ): Promise<{ items: PacketRecord[]; nextCursor?: string }> {
    const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT);
    const ids = this.byGoal.get(goalId) ?? [];
    let start = 0;
    if (options.cursor) {
      const idx = ids.indexOf(options.cursor);
      start = idx >= 0 ? idx + 1 : 0;
    }
    const slice = ids.slice(start, start + limit);
    const items = slice.map((id) => this.byId.get(id)).filter((r): r is PacketRecord => r !== undefined);
    const next = ids[start + limit];
    return next ? { items, nextCursor: next } : { items };
  }

  async close(): Promise<void> {
    this.byId.clear();
    this.byGoal.clear();
  }
}

export interface RedisPacketStoreOptions {
  url: string;
  keyPrefix?: string;
  /** How long manifests are retained (seconds). Default 7 days. */
  ttlSeconds?: number;
  clock?: Clock;
}

/**
 * Redis packet manifest store: one hash per packet id, one list per goal.
 */
export class RedisPacketStore implements PacketStore {
  private readonly client: Redis;
  private readonly prefix: string;
  private readonly ttlSeconds: number;

  constructor(options: RedisPacketStoreOptions) {
    this.prefix = options.keyPrefix ?? 'proba:context:packet:';
    this.ttlSeconds = options.ttlSeconds ?? 7 * 24 * 3600;
    this.client = new Redis(options.url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
  }

  async put(record: PacketRecord): Promise<void> {
    if (this.client.status !== 'ready') await this.client.connect();
    const key = `${this.prefix}id:${record.packetId}`;
    const goalKey = `${this.prefix}goal:${record.goalId}`;
    const payload = JSON.stringify(record);
    const multi = this.client.multi();
    multi.set(key, payload, 'EX', this.ttlSeconds);
    multi.lpush(goalKey, record.packetId);
    multi.ltrim(goalKey, 0, 999);
    multi.expire(goalKey, this.ttlSeconds);
    await multi.exec();
  }

  async get(packetId: string): Promise<PacketRecord | undefined> {
    if (this.client.status !== 'ready') await this.client.connect();
    const raw = await this.client.get(`${this.prefix}id:${packetId}`);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as PacketRecord;
    } catch {
      return undefined;
    }
  }

  async listByGoal(
    goalId: string,
    options: { limit?: number; cursor?: string } = {}
  ): Promise<{ items: PacketRecord[]; nextCursor?: string }> {
    if (this.client.status !== 'ready') await this.client.connect();
    const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT);
    const goalKey = `${this.prefix}goal:${goalId}`;
    const ids = await this.client.lrange(goalKey, 0, 999);
    let start = 0;
    if (options.cursor) {
      const idx = ids.indexOf(options.cursor);
      start = idx >= 0 ? idx + 1 : 0;
    }
    const slice = ids.slice(start, start + limit);
    const items: PacketRecord[] = [];
    for (const id of slice) {
      const record = await this.get(id);
      if (record) items.push(record);
    }
    const next = ids[start + limit];
    return next ? { items, nextCursor: next } : { items };
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}

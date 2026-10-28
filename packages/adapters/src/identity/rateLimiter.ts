import { Redis } from 'ioredis';
import type { Clock, RateLimitDecision, RateLimiter } from '@smallseedlabs/proba-context-core';

/** Thrown when an in-memory rate limiter is created in production. */
export class MemoryRateLimiterRefusedError extends Error {
  constructor() {
    super('The in-memory rate limiter is not allowed when NODE_ENV=production: use Redis.');
    this.name = 'MemoryRateLimiterRefusedError';
  }
}

interface Bucket {
  count: number;
  resetAt: number;
}

const MAX_KEYS = 10_000;

/**
 * Fixed-window in-process limiter. Refused in production.
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly clock: Clock = { now: () => new Date() },
    nodeEnv: string | undefined = process.env.NODE_ENV
  ) {
    if (nodeEnv === 'production') throw new MemoryRateLimiterRefusedError();
  }

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    const now = this.clock.now().getTime();
    let bucket = this.live(key, now);
    if (!bucket) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
      if (this.buckets.size > MAX_KEYS) this.sweep(now);
    }
    bucket.count += 1;
    return {
      allowed: bucket.count <= limit,
      limit,
      remaining: Math.max(0, limit - bucket.count),
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  async close(): Promise<void> {
    this.buckets.clear();
  }

  private live(key: string, now: number): Bucket | undefined {
    const bucket = this.buckets.get(key);
    if (bucket && bucket.resetAt <= now) {
      this.buckets.delete(key);
      return undefined;
    }
    return bucket;
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key);
  }
}

const HIT_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if c == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {c, ttl}
`;

export interface RedisRateLimiterOptions {
  url: string;
  keyPrefix?: string;
  connectTimeoutMs?: number;
}

/**
 * Fixed-window Redis limiter shared by every replica. Fails open if Redis is unreachable
 * (the request is allowed): privacy is enforced by identity, not by the rate limit.
 */
export class RedisRateLimiter implements RateLimiter {
  private readonly client: Redis;
  private readonly prefix: string;
  private readonly connectTimeoutMs: number;

  constructor(options: RedisRateLimiterOptions) {
    this.prefix = options.keyPrefix ?? 'proba:context:rl:';
    this.connectTimeoutMs = options.connectTimeoutMs ?? 2000;
    this.client = new Redis(options.url, {
      maxRetriesPerRequest: 1,
      connectTimeout: this.connectTimeoutMs,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
  }

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    try {
      if (this.client.status !== 'ready') await this.client.connect();
      const reply = (await this.client.eval(HIT_SCRIPT, 1, `${this.prefix}${key}`, String(windowMs))) as [number, number];
      const count = Number(reply[0]);
      const ttlMs = Number(reply[1]);
      return {
        allowed: count <= limit,
        limit,
        remaining: Math.max(0, limit - count),
        retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
      };
    } catch {
      return { allowed: true, limit, remaining: limit, retryAfterSeconds: 1 };
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}

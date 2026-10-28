import { Redis, type RedisOptions } from 'ioredis';
import { validateAuditEvent, type AuditEmitter, type AuditEventInput, type Clock } from '@smallseedlabs/proba-context-core';

/** The stream proba-audit's consumer reads (same default as the Hub). */
export const DEFAULT_AUDIT_STREAM = 'proba.audit.events';

/** The part of an ioredis client the emitter uses. */
export interface StreamClient {
  xadd(key: string, ...args: Array<string | number>): Promise<string | null>;
  quit?(): Promise<unknown>;
  disconnect?(): void;
}

export interface RedisStreamAuditEmitterOptions {
  client: StreamClient;
  clock: Clock;
  stream?: string;
  /** Approximate MAXLEN for the stream. Unset or 0 keeps everything. */
  maxStreamLength?: number;
}

/**
 * Appends audit events to the Redis stream proba-audit consumes, in the entry format the Hub uses:
 *
 *   XADD <stream> [MAXLEN ~ n] * data=<JSON AuditEvent> publishedAt=<UTC ISO> key=<workspaceId>
 *
 * Every event is validated against the protocol's `AuditEvent` schema first; an invalid event is rejected
 * rather than written. Errors propagate, so the caller can decide to fail closed.
 */
export class RedisStreamAuditEmitter implements AuditEmitter {
  private readonly stream: string;

  constructor(private readonly options: RedisStreamAuditEmitterOptions) {
    this.stream = options.stream ?? DEFAULT_AUDIT_STREAM;
  }

  async emit(event: AuditEventInput): Promise<void> {
    const parsed = validateAuditEvent(event);
    if (!parsed.success) {
      throw new Error(`audit event "${String(event.action)}" is not a valid AuditEvent: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    }
    const trim = this.options.maxStreamLength ? (['MAXLEN', '~', this.options.maxStreamLength] as const) : [];
    await this.options.client.xadd(
      this.stream,
      ...trim,
      '*',
      'data',
      JSON.stringify(parsed.data),
      'publishedAt',
      this.options.clock.now().toISOString(),
      'key',
      parsed.data.workspaceId
    );
  }

  /** Closes the connection; falls back to dropping it when Redis cannot be reached for a clean QUIT. */
  async close(): Promise<void> {
    try {
      await this.options.client.quit?.();
    } catch {
      this.options.client.disconnect?.();
    }
  }
}

export interface RedisConnectionOptions {
  url: string;
  clock: Clock;
  stream?: string;
  maxStreamLength?: number;
  redis?: RedisOptions;
}

/** Connects to Redis and returns an emitter on the audit stream. */
export function createRedisStreamAuditEmitter(options: RedisConnectionOptions): RedisStreamAuditEmitter {
  const client = new Redis(options.url, {
    // Commands wait for the connection (so the first event after start-up is not lost) but never for long:
    // an unreachable Redis fails the emit, and the build fails closed.
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 2000,
    ...options.redis,
  });
  // Connection errors surface on the next emit; without a listener ioredis would also print them.
  client.on('error', () => undefined);
  return new RedisStreamAuditEmitter({
    client,
    clock: options.clock,
    ...(options.stream ? { stream: options.stream } : {}),
    ...(options.maxStreamLength ? { maxStreamLength: options.maxStreamLength } : {}),
  });
}

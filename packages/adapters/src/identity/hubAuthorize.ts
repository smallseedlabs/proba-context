import { IdentityRejectedError, type Clock } from '@smallseedlabs/proba-context-core';
import type { DownstreamClient } from '../http/downstreamClient.js';
import { SourceAdapterError } from '../http/errors.js';

export interface AuthorizeRequest {
  userId: string;
  workspaceId: string;
  goalId: string;
  actAsAssertion: string;
  signal?: AbortSignal;
}

export interface AuthorizeResult {
  allowed: boolean;
  reason: string;
}

export interface HubAuthorizePort {
  authorize(req: AuthorizeRequest): Promise<AuthorizeResult>;
}

export interface HubAuthorizeClientOptions {
  client: DownstreamClient;
  /** When set, successful/negative answers are cached for `ttlSeconds`. */
  cache?: { enabled: boolean; ttlSeconds: number; clock?: Clock };
}

/**
 * Calls Hub `POST /v1/internal/authorize` with the bridge service token and the
 * caller's act-as assertion. Optional in-process cache (only when config enables it).
 */
export class HubAuthorizeClient implements HubAuthorizePort {
  private readonly cache = new Map<string, { expiresAt: number; result: AuthorizeResult }>();
  private readonly clock: Clock;

  constructor(private readonly options: HubAuthorizeClientOptions) {
    this.clock = options.cache?.clock ?? { now: () => new Date() };
  }

  async authorize(req: AuthorizeRequest): Promise<AuthorizeResult> {
    const cacheKey = `${req.userId}:${req.workspaceId}:${req.goalId}`;
    const cached = this.readCache(cacheKey);
    if (cached) return cached;

    let response: { json: unknown };
    try {
      response = await this.options.client.request({
        method: 'POST',
        path: '/v1/internal/authorize',
        actAsAssertion: req.actAsAssertion,
        body: { userId: req.userId, workspaceId: req.workspaceId, goalId: req.goalId },
        ...(req.signal ? { signal: req.signal } : {}),
      });
    } catch (err) {
      if (err instanceof SourceAdapterError && err.causeStatus === 403) {
        throw new IdentityRejectedError('authorize_denied', 'The caller is not authorised for this goal.');
      }
      throw new IdentityRejectedError('authorize_unavailable', 'Hub authorize could not be completed.');
    }

    const body = response.json as { allowed?: unknown; reason?: unknown } | null;
    if (typeof body?.allowed !== 'boolean') {
      throw new IdentityRejectedError('authorize_unavailable', 'Hub authorize returned an unexpected response.');
    }
    const result: AuthorizeResult = {
      allowed: body.allowed,
      reason: typeof body.reason === 'string' && body.reason ? body.reason : body.allowed ? 'ok' : 'denied',
    };
    this.writeCache(cacheKey, result);
    return result;
  }

  private readCache(key: string): AuthorizeResult | undefined {
    const cfg = this.options.cache;
    if (!cfg?.enabled || cfg.ttlSeconds <= 0) return undefined;
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.clock.now().getTime()) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.result;
  }

  private writeCache(key: string, result: AuthorizeResult): void {
    const cfg = this.options.cache;
    if (!cfg?.enabled || cfg.ttlSeconds <= 0) return;
    this.cache.set(key, { result, expiresAt: this.clock.now().getTime() + cfg.ttlSeconds * 1000 });
  }
}

import type { DownstreamAudience, ServiceTokenSigner } from './serviceToken.js';
import { assertAllowedBaseUrl, hostKeyFromUrl } from './allowlist.js';
import { CircuitBreaker } from './circuitBreaker.js';
import { CircuitOpenError, DownstreamHostRefusedError, SourceAdapterError } from './errors.js';
import { RetryableFailure, isRetryableStatus, withRetries, type RetryOptions } from './retry.js';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface DownstreamClientOptions {
  /** Logical name for the circuit breaker (e.g. `proba-memory`). */
  name: string;
  baseUrl: string;
  audience: DownstreamAudience;
  allowedHosts: readonly string[];
  tokenSigner: ServiceTokenSigner;
  /** Max response body bytes. Default 1_048_576. */
  maxResponseBytes?: number;
  circuit?: CircuitBreaker;
  fetch?: FetchLike;
  retry?: RetryOptions;
}

export interface DownstreamRequest {
  method: 'GET' | 'POST';
  /** Path beginning with `/`. */
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** Raw `X-Act-As` JWT. */
  actAsAssertion: string;
  signal?: AbortSignal;
}

export interface DownstreamResponse {
  status: number;
  json: unknown;
}

/**
 * HTTP client for a single downstream (memory-api or audit-api): SSRF allow-list, service JWT,
 * `X-Act-As` forwarding, response size cap, bounded retries with jitter, and a circuit breaker.
 * TLS verification is whatever Node's `fetch` does (on by default for https).
 */
export class DownstreamClient {
  private readonly base: URL;
  private readonly maxResponseBytes: number;
  private readonly circuit: CircuitBreaker;
  private readonly fetchImpl: FetchLike;
  private readonly retry: RetryOptions;

  constructor(private readonly options: DownstreamClientOptions) {
    this.base = assertAllowedBaseUrl(options.baseUrl, options.allowedHosts);
    this.maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
    this.circuit = options.circuit ?? new CircuitBreaker(options.name);
    this.fetchImpl = options.fetch ?? fetch;
    this.retry = options.retry ?? {};
  }

  get hostKey(): string {
    return hostKeyFromUrl(this.base);
  }

  async request(req: DownstreamRequest): Promise<DownstreamResponse> {
    if (!req.actAsAssertion.trim()) {
      throw new SourceAdapterError('source_error', 'X-Act-As assertion is required for downstream reads.');
    }
    this.circuit.beforeCall();

    try {
      const result = await withRetries(async () => {
        const token = await this.options.tokenSigner.mint(this.options.audience);
        const url = this.buildUrl(req.path, req.query);
        // Re-check on every call so a crafted path cannot retarget the host.
        assertAllowedBaseUrl(url.origin, this.options.allowedHosts);
        if (hostKeyFromUrl(url) !== hostKeyFromUrl(this.base) && url.hostname.toLowerCase() !== this.base.hostname.toLowerCase()) {
          throw new DownstreamHostRefusedError(hostKeyFromUrl(url));
        }

        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          'X-Act-As': req.actAsAssertion,
          Accept: 'application/json',
        };
        let body: string | undefined;
        if (req.body !== undefined) {
          headers['Content-Type'] = 'application/json';
          body = JSON.stringify(req.body);
        }

        let response: Response;
        try {
          response = await this.fetchImpl(url, { method: req.method, headers, body, signal: req.signal });
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') throw err;
          throw new RetryableFailure(0, err instanceof Error ? err.message : 'network error');
        }

        if (isRetryableStatus(response.status)) {
          throw new RetryableFailure(response.status);
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > this.maxResponseBytes) {
          throw new SourceAdapterError('source_error', `Downstream response exceeded ${this.maxResponseBytes} bytes.`);
        }

        let json: unknown = null;
        if (buffer.byteLength > 0) {
          try {
            json = JSON.parse(buffer.toString('utf8')) as unknown;
          } catch {
            throw new SourceAdapterError('source_error', 'Downstream response was not JSON.');
          }
        }

        if (response.status < 200 || response.status >= 300) {
          throw new SourceAdapterError('source_error', `Downstream returned HTTP ${response.status}.`, {
            causeStatus: response.status,
          });
        }

        return { status: response.status, json };
      }, this.retry);

      this.circuit.recordSuccess();
      return result;
    } catch (err) {
      if (!(err instanceof CircuitOpenError) && !(err instanceof DownstreamHostRefusedError)) {
        this.circuit.recordFailure();
      }
      if (err instanceof RetryableFailure) {
        throw new SourceAdapterError('source_error', `Downstream returned HTTP ${err.status || 'error'} after retries.`, {
          causeStatus: err.status || undefined,
          cause: err,
        });
      }
      throw err;
    }
  }

  private buildUrl(path: string, query?: Record<string, string | undefined>): URL {
    if (!path.startsWith('/')) throw new SourceAdapterError('source_error', 'Downstream path must be absolute.');
    const url = new URL(path, this.base);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== '') url.searchParams.set(key, value);
      }
    }
    return url;
  }
}

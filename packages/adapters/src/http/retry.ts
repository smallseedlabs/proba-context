export interface RetryOptions {
  /** Extra attempts after the first try. Default 2 (three tries in total). */
  maxRetries?: number;
  /** Base delay in ms before the first retry. Default 50. */
  baseDelayMs?: number;
  /** Cap on delay. Default 1000. */
  maxDelayMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests. Default Math.random. */
  random?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full-jitter delay: uniform in [0, min(maxDelay, base * 2^attempt)]. */
export function retryDelayMs(attempt: number, options: RetryOptions = {}): number {
  const base = options.baseDelayMs ?? 50;
  const max = options.maxDelayMs ?? 1000;
  const random = options.random ?? Math.random;
  const ceiling = Math.min(max, base * 2 ** attempt);
  return Math.floor(random() * (ceiling + 1));
}

/** Status codes that are safe to retry. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * Runs `fn` and retries on retryable failures with full-jitter backoff.
 * `fn` should throw or return a value; use {@link RetryableFailure} to signal a retryable HTTP status.
 */
export async function withRetries<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? 2;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const retryable = err instanceof RetryableFailure || (err instanceof TypeError && /fetch|network|ECONN|ETIMEDOUT/i.test(err.message));
      if (!retryable || attempt >= maxRetries) throw err;
      await sleep(retryDelayMs(attempt, options));
    }
  }
  throw lastError;
}

/** Thrown inside a retry loop to request another attempt. */
export class RetryableFailure extends Error {
  readonly status: number;

  constructor(status: number, message?: string) {
    super(message ?? `Retryable HTTP ${status}`);
    this.name = 'RetryableFailure';
    this.status = status;
  }
}

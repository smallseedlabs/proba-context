import { CircuitOpenError } from './errors.js';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Failures in a row that open the circuit. Default 5. */
  failureThreshold?: number;
  /** Milliseconds to stay open before a half-open probe. Default 30_000. */
  resetMs?: number;
  /** Successful probes in half-open that close the circuit. Default 1. */
  successThreshold?: number;
  now?: () => number;
}

/**
 * Per-downstream circuit breaker with closed → open → half-open probing.
 * Call {@link beforeCall} before each attempt; {@link recordSuccess} / {@link recordFailure} after.
 */
export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly resetMs: number;
  private readonly successThreshold: number;
  private readonly now: () => number;
  private failures = 0;
  private successes = 0;
  private openedAt = 0;
  private state: CircuitState = 'closed';

  constructor(
    private readonly name: string,
    options: CircuitBreakerOptions = {}
  ) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetMs = options.resetMs ?? 30_000;
    this.successThreshold = options.successThreshold ?? 1;
    this.now = options.now ?? Date.now;
  }

  getState(): CircuitState {
    this.maybeHalfOpen();
    return this.state;
  }

  /** Throws {@link CircuitOpenError} when the circuit is open. */
  beforeCall(): void {
    this.maybeHalfOpen();
    if (this.state === 'open') throw new CircuitOpenError(this.name);
  }

  recordSuccess(): void {
    if (this.state === 'half_open') {
      this.successes += 1;
      if (this.successes >= this.successThreshold) {
        this.state = 'closed';
        this.failures = 0;
        this.successes = 0;
      }
      return;
    }
    this.failures = 0;
  }

  recordFailure(): void {
    if (this.state === 'half_open') {
      this.trip();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) this.trip();
  }

  private trip(): void {
    this.state = 'open';
    this.openedAt = this.now();
    this.successes = 0;
  }

  private maybeHalfOpen(): void {
    if (this.state === 'open' && this.now() - this.openedAt >= this.resetMs) {
      this.state = 'half_open';
      this.successes = 0;
    }
  }
}

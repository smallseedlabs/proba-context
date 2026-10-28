import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from './circuitBreaker.js';
import { CircuitOpenError } from './errors.js';

describe('CircuitBreaker', () => {
  it('opens after the failure threshold and half-opens after resetMs', () => {
    let now = 1_000;
    const cb = new CircuitBreaker('x', { failureThreshold: 2, resetMs: 100, now: () => now });
    cb.beforeCall();
    cb.recordFailure();
    cb.beforeCall();
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    expect(() => cb.beforeCall()).toThrow(CircuitOpenError);
    now += 100;
    expect(cb.getState()).toBe('half_open');
    cb.beforeCall();
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
  });

  it('re-opens when a half-open probe fails', () => {
    let now = 0;
    const cb = new CircuitBreaker('y', { failureThreshold: 1, resetMs: 10, now: () => now });
    cb.beforeCall();
    cb.recordFailure();
    now += 10;
    cb.beforeCall();
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
  });
});

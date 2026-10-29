import { describe, expect, it } from 'vitest';
import { RedisCachePasswordRequiredError, assertRedisPassword, tlsOptionsFromUrl } from './redisCache.js';

describe('Redis cache production guards', () => {
  it('refuses a passwordless Redis URL in production', () => {
    expect(() => assertRedisPassword('redis://redis:6379', 'production')).toThrow(RedisCachePasswordRequiredError);
    expect(() => assertRedisPassword('redis://:secret@redis:6379', 'production')).not.toThrow();
    expect(() => assertRedisPassword('redis://redis:6379', 'test')).not.toThrow();
  });

  it('enables TLS options for rediss:// and REDIS_TLS', () => {
    expect(tlsOptionsFromUrl('rediss://:pw@redis:6379').tls).toBeDefined();
    const prev = process.env.REDIS_TLS;
    process.env.REDIS_TLS = 'true';
    try {
      expect(tlsOptionsFromUrl('redis://:pw@redis:6379').tls).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.REDIS_TLS;
      else process.env.REDIS_TLS = prev;
    }
  });
});

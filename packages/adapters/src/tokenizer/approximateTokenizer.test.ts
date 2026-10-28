import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ApproximateTokenizer } from './approximateTokenizer.js';

describe('ApproximateTokenizer', () => {
  const tokenizer = new ApproximateTokenizer();

  it('counts one token per four characters, rounded up', () => {
    expect(tokenizer.count('')).toBe(0);
    expect(tokenizer.count('a')).toBe(1);
    expect(tokenizer.count('abcd')).toBe(1);
    expect(tokenizer.count('abcde')).toBe(2);
  });

  it('is monotonic in length and subadditive over concatenation', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(tokenizer.count(a + b)).toBeGreaterThanOrEqual(tokenizer.count(a));
        expect(tokenizer.count(a + b)).toBeLessThanOrEqual(tokenizer.count(a) + tokenizer.count(b));
      })
    );
  });
});

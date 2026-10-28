import type { Tokenizer } from '@smallseedlabs/proba-context-core';

/**
 * Estimates tokens as one per four UTF-16 code units, rounded up. It over-counts plain English a little and
 * under-counts dense text such as CJK, so budgets should keep some headroom. Pure and deterministic.
 */
export class ApproximateTokenizer implements Tokenizer {
  static readonly CHARS_PER_TOKEN = 4;

  count(text: string): number {
    return Math.ceil(text.length / ApproximateTokenizer.CHARS_PER_TOKEN);
  }
}

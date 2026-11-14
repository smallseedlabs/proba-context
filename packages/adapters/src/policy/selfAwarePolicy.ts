import type { PolicySource, SourceQuery, SourceResult } from '@smallseedlabs/proba-context-core';
import type { ContextItem } from '@smallseedlabs/proba-protocol';

export interface SelfFetcher {
  fetchSelf(query: SourceQuery): Promise<ContextItem[]>;
}

export interface SelfAwarePolicySourceOptions {
  /** The policy statements (policy.yaml). Always served. */
  base: PolicySource;
  /** Proba's bootstrap self memory (memory-api). */
  self: SelfFetcher;
  /** Most time the self memory may take; the policy section has its own, larger, timeout. Default 400 ms. */
  selfTimeoutMs?: number;
  /** Told when the self memory could not be read; the packet then carries the policy statements only. */
  onSelfUnavailable?: (reason: string) => void;
}

/**
 * The policy section with Proba's bootstrap self memory first. The self memory is the identity and behaviour the brain works from;
 * policy.yaml statements follow. A self memory that cannot be read never fails the build (policy is build-critical): the packet
 * carries the policy statements alone and the failure is reported through `onSelfUnavailable`.
 */
export class SelfAwarePolicySource implements PolicySource {
  constructor(private readonly options: SelfAwarePolicySourceOptions) {}

  async fetchPolicy(query: SourceQuery): Promise<SourceResult> {
    const [self, base] = await Promise.all([this.readSelf(query), this.options.base.fetchPolicy(query)]);
    return { items: [...self, ...base.items] };
  }

  private async readSelf(query: SourceQuery): Promise<ContextItem[]> {
    const timeoutMs = this.options.selfTimeoutMs ?? 400;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.options.self.fetchSelf(query),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`self memory timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } catch (err) {
      this.options.onSelfUnavailable?.(err instanceof Error ? err.message : String(err));
      return [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

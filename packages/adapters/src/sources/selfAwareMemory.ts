import type { MemorySource, SourceQuery, SourceResult } from '@smallseedlabs/proba-context-core';
import type { ContextItem } from '@smallseedlabs/proba-protocol';

export interface SelfDetailFetcher {
  fetchDetails(query: SourceQuery): Promise<ContextItem[]>;
}

export interface SelfAwareMemorySourceOptions {
  base: MemorySource;
  self: SelfDetailFetcher;
  /** Most time the self detail may take. Default 400 ms. */
  selfTimeoutMs?: number;
  onSelfUnavailable?: (reason: string) => void;
}

/**
 * The memory section plus Proba's self detail entries as candidates. The build keeps a detail entry only when its tags match the
 * run (see `scoreSelfDetails` in core) and the memory section's budget has room; the core is in the policy section instead.
 * Details are offered on the base recall only, never on a `memory_search` need. A self read that fails or is slow never fails the
 * memory section: the user's memories are returned alone.
 */
export class SelfAwareMemorySource implements MemorySource {
  constructor(private readonly options: SelfAwareMemorySourceOptions) {}

  async recall(query: SourceQuery, limit: number): Promise<SourceResult> {
    const [base, details] = await Promise.all([this.options.base.recall(query, limit), this.readDetails(query)]);
    return { items: [...base.items, ...details] };
  }

  search(query: SourceQuery, text: string, limit: number): Promise<SourceResult> {
    return this.options.base.search(query, text, limit);
  }

  private async readDetails(query: SourceQuery): Promise<ContextItem[]> {
    const timeoutMs = this.options.selfTimeoutMs ?? 400;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.options.self.fetchDetails(query),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`self detail timed out after ${timeoutMs}ms`)), timeoutMs);
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

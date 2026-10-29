import type { ContextItem } from '../protocol.js';
import { contextItemSchema } from '../protocol.js';
import type { Clock, SourceQuery } from '../ports/index.js';
import type { FetchJob } from './plan.js';

export type FetchStatus = 'ok' | 'timeout' | 'error';

export interface FetchOutcome {
  job: FetchJob;
  status: FetchStatus;
  /** Items the source returned that are valid context items. */
  items: ContextItem[];
  /** Items the source returned in total, valid or not. */
  returned: number;
  latencyMs: number;
  timeoutMs: number;
  /**
   * Gap code suggested by the source adapter when `status` is `error`
   * (for example `source_error` after a schema validation failure).
   */
  gapCode?: string;
  /** True when the payload came from `ContextCache` (already redacted). */
  cacheHit?: boolean;
  /** Cache key used for this job, when caching is enabled for the source. */
  cacheKey?: string;
}

class SourceTimeout extends Error {}

/**
 * Step 3, one source: call it under its timeout. Never throws: a source that fails or runs out of time
 * yields an outcome with no items and a status the caller turns into a gap.
 */
export async function runJob(
  job: FetchJob,
  query: Omit<SourceQuery, 'signal'>,
  timeoutMs: number,
  clock: Clock
): Promise<FetchOutcome> {
  const startedAt = clock.now().getTime();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SourceTimeout());
    }, timeoutMs);
  });
  const finish = (status: FetchStatus, raw: readonly unknown[] = [], gapCode?: string): FetchOutcome => {
    const items = raw.flatMap((candidate) => {
      const parsed = contextItemSchema.safeParse(candidate);
      return parsed.success ? [parsed.data as ContextItem] : [];
    });
    return {
      job,
      status,
      items,
      returned: raw.length,
      latencyMs: Math.max(0, clock.now().getTime() - startedAt),
      timeoutMs,
      ...(gapCode ? { gapCode } : {}),
    };
  };
  try {
    const result = await Promise.race([job.run({ ...query, signal: controller.signal }), timeout]);
    if (!result || !Array.isArray(result.items)) return finish('error', [], 'source_error');
    return finish('ok', result.items);
  } catch (err) {
    if (err instanceof SourceTimeout) return finish('timeout');
    // Adapters may set `gapCode` (e.g. `source_error` after schema validation). Other failures keep the section's `*_unavailable` code.
    const gapCode =
      err !== null && typeof err === 'object' && 'gapCode' in err && typeof (err as { gapCode: unknown }).gapCode === 'string'
        ? (err as { gapCode: string }).gapCode
        : undefined;
    return finish('error', [], gapCode);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

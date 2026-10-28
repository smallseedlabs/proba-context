import { Redactor } from '../redaction/index.js';
import type { ContextItem, SectionKind } from '../protocol.js';
import { clampTrust } from './sections.js';

const MAX_DEPTH = 12;
/** Keys whose string values are identifiers: only secrets are redacted in them, so that ids are not mangled by personal-data patterns. */
const ID_KEY = /(^|_)id$|Id$|^ids$|Ids$/;

export interface SanitiseOptions {
  pii: boolean;
  maxItemChars: number;
}

export interface Sanitised {
  item: ContextItem;
  redactions: number;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // Do not cut a surrogate pair in half.
  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, Math.max(0, end))}\u2026`;
}

/**
 * Step 5: redact the text and the string leaves of `data`, cap the length of text, and set the trust label.
 * Returns a copy; the source's own object is left alone.
 */
export function sanitiseItem(kind: SectionKind, item: ContextItem, options: SanitiseOptions): Sanitised {
  const full = new Redactor({ pii: options.pii });
  const secretsOnly = new Redactor({ pii: false });
  let redactions = 0;
  const redact = (value: string, redactor: Redactor = full): string => {
    const result = redactor.redact(value);
    for (const r of result.redactions) redactions += r.count;
    return result.text;
  };
  const walk = (value: unknown, depth: number, key?: string): unknown => {
    if (typeof value === 'string') return redact(value, key !== undefined && ID_KEY.test(key) ? secretsOnly : full);
    if (Array.isArray(value)) return depth >= MAX_DEPTH ? [] : value.map((v) => walk(v, depth + 1, key));
    if (value !== null && typeof value === 'object') {
      if (depth >= MAX_DEPTH) return {};
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v, depth + 1, k)]));
    }
    return value;
  };

  const out: ContextItem = {
    ...item,
    sourceRef: { ...item.sourceRef },
    trust: clampTrust(kind, item.trust),
  };
  if (item.text !== undefined) out.text = truncate(redact(item.text), options.maxItemChars);
  if (item.data !== undefined) out.data = walk(item.data, 0);
  return { item: out, redactions };
}

import { createHash } from 'node:crypto';
import type { ContextPacket } from '@smallseedlabs/proba-protocol';

/**
 * Canonical JSON for hashing: object keys sorted recursively, `undefined` properties omitted,
 * no whitespace. Array order is preserved. Non-finite numbers and values JSON cannot carry are rejected.
 */
export function canonicalizeForHash(value: unknown): string {
  return canonicalize(value, new Set<object>()) ?? 'null';
}

function canonicalize(value: unknown, seen: Set<object>): string | undefined {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalizeForHash: non-finite number');
      return JSON.stringify(value);
    case 'bigint':
      throw new TypeError('canonicalizeForHash: bigint is not representable in JSON');
    default:
      break;
  }
  const obj = value as object;
  if (seen.has(obj)) throw new TypeError('canonicalizeForHash: circular structure');
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      // Like JSON.stringify, an undefined array element becomes null so positions stay stable.
      return `[${obj.map((v) => canonicalize(v, seen) ?? 'null').join(',')}]`;
    }
    if (obj instanceof Date) return JSON.stringify(obj.toISOString());
    const record = obj as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const encoded = canonicalize(record[key], seen);
      if (encoded !== undefined) parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

/** A packet before its hash is known. */
export type ContextPacketWithoutHash = Omit<ContextPacket, 'packetHash'>;

/** SHA-256 (lower-case hex) of the canonical JSON of a packet that has no `packetHash` yet. */
export function computePacketHash(packetWithoutHash: ContextPacketWithoutHash): string {
  return createHash('sha256').update(canonicalizeForHash(packetWithoutHash), 'utf8').digest('hex');
}

import { describe, expect, it } from 'vitest';
import { canonicalizeForHash, computePacketHash, type ContextPacketWithoutHash } from './packetHash.js';

const basePacket = (): ContextPacketWithoutHash => ({
  packetId: '990e8400-e29b-41d4-a716-446655440004',
  traceId: '550e8400-e29b-41d4-a716-446655440000',
  workspaceId: 'seedbed',
  userId: '660e8400-e29b-41d4-a716-446655440001',
  goalId: '770e8400-e29b-41d4-a716-446655440002',
  stepId: 'step-1',
  configVersion: '1',
  templateVersion: '1',
  sections: [
    {
      kind: 'policy',
      priority: 0,
      tokens: 8,
      items: [
        {
          itemId: 'pol-1',
          sourceRef: { source: 'policy', id: 'default' },
          trust: 'system',
          text: 'Spend above 100 GBP per day needs approval.',
          observedAt: '2026-10-28T00:00:00.000Z',
        },
      ],
    },
  ],
  gaps: [],
  manifest: {
    sources: {},
    totals: { returned: 1, included: 1, dropped: 0, tokens: 8, gaps: 0, latencyMs: 3 },
    droppedItemIds: [],
  },
});

/** Same value with the keys of every object inserted in reverse alphabetical order. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .reverse()
        .map((k) => [k, reverseKeys(record[k])])
    );
  }
  return value;
}

describe('canonicalizeForHash', () => {
  it('sorts keys recursively and uses no whitespace', () => {
    expect(canonicalizeForHash({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('omits undefined properties but keeps null', () => {
    expect(canonicalizeForHash({ a: undefined, b: null, c: 1 })).toBe('{"b":null,"c":1}');
  });

  it('keeps array order and turns undefined elements into null', () => {
    expect(canonicalizeForHash([2, 1, undefined])).toBe('[2,1,null]');
  });

  it('escapes strings like JSON', () => {
    expect(canonicalizeForHash({ t: 'a"b\n' })).toBe('{"t":"a\\"b\\n"}');
  });

  it('rejects values JSON cannot carry', () => {
    expect(() => canonicalizeForHash({ n: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalizeForHash({ n: 1n })).toThrow(/bigint/);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => canonicalizeForHash(circular)).toThrow(/circular/);
  });
});

describe('computePacketHash', () => {
  it('is a lower-case SHA-256 hex digest', () => {
    expect(computePacketHash(basePacket())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for equal inputs, whatever the key order', () => {
    const a = basePacket();
    const reordered = reverseKeys(basePacket()) as ContextPacketWithoutHash;
    expect(computePacketHash(a)).toBe(computePacketHash(basePacket()));
    expect(Object.keys(reordered)[0]).not.toBe(Object.keys(a)[0]);
    expect(computePacketHash(reordered)).toBe(computePacketHash(a));
  });

  it('ignores undefined optional fields', () => {
    const withUndefined = basePacket();
    withUndefined.sections[0]!.items[0]!.score = undefined;
    expect(computePacketHash(withUndefined)).toBe(computePacketHash(basePacket()));
  });

  it('changes when content changes', () => {
    const changed = basePacket();
    changed.sections[0]!.items[0]!.text = 'Spend above 200 GBP per day needs approval.';
    expect(computePacketHash(changed)).not.toBe(computePacketHash(basePacket()));
  });

  it('changes when the template version changes', () => {
    expect(computePacketHash({ ...basePacket(), templateVersion: '2' })).not.toBe(computePacketHash(basePacket()));
  });
});

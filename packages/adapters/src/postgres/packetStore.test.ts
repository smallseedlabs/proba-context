import { describe, expect, it, vi } from 'vitest';
import { PostgresPacketStore } from './packetStore.js';
import type { PacketRecord } from '@smallseedlabs/proba-context-core';

function record(over: Partial<PacketRecord> = {}): PacketRecord {
  return {
    packetId: '11111111-1111-4111-8111-111111111111',
    packetHash: 'abc',
    workspaceId: 'seedbed',
    userId: 'user-a',
    goalId: '22222222-2222-4222-8222-222222222222',
    stepId: 'step-1',
    stepType: 'propose_budget',
    configVersion: '1',
    templateVersion: '1',
    manifest: {
      sources: {},
      totals: { returned: 0, included: 0, dropped: 0, gaps: 0, tokens: 0, latencyMs: 0 },
      droppedItemIds: [],
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('PostgresPacketStore', () => {
  it('refuses put without stepType', async () => {
    const store = new PostgresPacketStore({
      pool: { query: vi.fn(), end: vi.fn() } as never,
    });
    await expect(store.put(record({ stepType: undefined }))).rejects.toThrow(/stepType/);
  });

  it('inserts a manifest-only row', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const store = new PostgresPacketStore({ pool: { query, end: vi.fn() } as never });
    await store.put(record());
    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO context_packets/);
    expect(params[6]).toBe('propose_budget');
    expect(typeof params[9]).toBe('string');
    expect(JSON.parse(params[9] as string)).not.toHaveProperty('items');
  });

  it('maps a row back to PacketRecord', async () => {
    const row = {
      packet_id: '11111111-1111-4111-8111-111111111111',
      packet_hash: 'abc',
      workspace_id: 'seedbed',
      user_id: 'user-a',
      goal_id: '22222222-2222-4222-8222-222222222222',
      step_id: 'step-1',
      step_type: 'propose_budget',
      config_version: '1',
      template_version: '1',
      manifest: { sources: {}, totals: {}, droppedItemIds: [] },
      created_at: new Date('2026-01-01T00:00:00.000Z'),
    };
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const store = new PostgresPacketStore({ pool: { query, end: vi.fn() } as never });
    const got = await store.get(row.packet_id);
    expect(got?.stepType).toBe('propose_budget');
    expect(got?.packetHash).toBe('abc');
  });

  it('purges rows older than the cutoff', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 3 });
    const store = new PostgresPacketStore({ pool: { query, end: vi.fn() } as never });
    const n = await store.purgeExpired(new Date('2026-01-10T00:00:00.000Z'));
    expect(n).toBe(3);
    expect(query.mock.calls[0]?.[0]).toMatch(/DELETE FROM context_packets/);
  });
});

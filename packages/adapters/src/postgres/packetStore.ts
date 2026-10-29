import type { Clock, PacketRecord, PacketStore } from '@smallseedlabs/proba-context-core';
import type pg from 'pg';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

export interface PostgresPacketStoreOptions {
  pool: pg.Pool;
  clock?: Clock;
}

function rowToRecord(row: Record<string, unknown>): PacketRecord {
  const manifest = row.manifest;
  return {
    packetId: String(row.packet_id),
    packetHash: String(row.packet_hash),
    workspaceId: String(row.workspace_id),
    userId: String(row.user_id),
    goalId: String(row.goal_id),
    stepId: String(row.step_id),
    stepType: String(row.step_type),
    configVersion: String(row.config_version),
    templateVersion: String(row.template_version),
    manifest: (typeof manifest === 'string' ? JSON.parse(manifest) : manifest) as PacketRecord['manifest'],
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
  };
}

/**
 * Postgres packet manifest store. Stores the manifest JSON only — never item text.
 */
export class PostgresPacketStore implements PacketStore {
  private readonly pool: pg.Pool;

  constructor(options: PostgresPacketStoreOptions) {
    this.pool = options.pool;
  }

  async put(record: PacketRecord): Promise<void> {
    if (!record.stepType?.trim()) {
      throw new Error('PacketRecord.stepType is required for the Postgres packet store');
    }
    await this.pool.query(
      `INSERT INTO context_packets (
         packet_id, packet_hash, workspace_id, user_id, goal_id, step_id, step_type,
         config_version, template_version, manifest, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
       ON CONFLICT (packet_id) DO NOTHING`,
      [
        record.packetId,
        record.packetHash,
        record.workspaceId,
        record.userId,
        record.goalId,
        record.stepId,
        record.stepType,
        record.configVersion,
        record.templateVersion,
        JSON.stringify(record.manifest),
        record.createdAt,
      ]
    );
  }

  async get(packetId: string): Promise<PacketRecord | undefined> {
    const result = await this.pool.query(`SELECT * FROM context_packets WHERE packet_id = $1`, [packetId]);
    const row = result.rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  async listByGoal(
    goalId: string,
    options: { limit?: number; cursor?: string } = {}
  ): Promise<{ items: PacketRecord[]; nextCursor?: string }> {
    const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT);
    let createdAt: string | undefined;
    let cursorId: string | undefined;
    if (options.cursor) {
      const cursorRow = await this.get(options.cursor);
      if (cursorRow) {
        createdAt = cursorRow.createdAt;
        cursorId = cursorRow.packetId;
      }
    }

    const params: unknown[] = [goalId, limit + 1];
    let sql = `SELECT * FROM context_packets WHERE goal_id = $1`;
    if (createdAt && cursorId) {
      params.push(createdAt, cursorId);
      sql += ` AND (created_at, packet_id) < ($3::timestamptz, $4::uuid)`;
    }
    sql += ` ORDER BY created_at DESC, packet_id DESC LIMIT $2`;

    const result = await this.pool.query(sql, params);
    const rows = result.rows.map(rowToRecord);
    if (rows.length > limit) {
      const items = rows.slice(0, limit);
      return { items, nextCursor: items[items.length - 1]?.packetId };
    }
    return { items: rows };
  }

  async purgeExpired(olderThan: Date): Promise<number> {
    const result = await this.pool.query(`DELETE FROM context_packets WHERE created_at < $1`, [
      olderThan.toISOString(),
    ]);
    return result.rowCount ?? 0;
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

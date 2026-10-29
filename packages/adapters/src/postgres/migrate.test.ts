import { describe, expect, it, vi } from 'vitest';
import { readMigrations, migrate } from './migrate.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDir = fileURLToPath(new URL('../../../../migrations/postgres', import.meta.url));

describe('postgres migrations', () => {
  it('discovers the context_packets migration', () => {
    const files = readMigrations(migrationsDir);
    expect(files.map((f) => f.name)).toContain('0001_context_packets.sql');
    expect(files[0]?.sql).toMatch(/CREATE TABLE IF NOT EXISTS context_packets/);
    expect(files[0]?.sql).not.toMatch(/item.?text/i);
  });

  it('applies a new migration and refuses a checksum change', async () => {
    const applied = new Map<string, string>();
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('pg_advisory_lock') || sql.includes('pg_advisory_unlock') || sql === 'BEGIN' || sql === 'COMMIT') {
          return { rows: [] };
        }
        if (sql.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) return { rows: [] };
        if (sql.includes('SELECT version, checksum')) {
          return { rows: [...applied.entries()].map(([version, checksum]) => ({ version, checksum })) };
        }
        if (sql.startsWith('INSERT INTO schema_migrations')) {
          applied.set(String(params?.[0]), String(params?.[2]));
          return { rows: [] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as never;

    const first = await migrate({ pool, dir: migrationsDir });
    expect(first.applied).toContain('0001_context_packets.sql');

    const second = await migrate({ pool, dir: migrationsDir });
    expect(second.alreadyApplied).toContain('0001_context_packets.sql');
    expect(second.applied).toEqual([]);
  });

  it('points DEFAULT_MIGRATIONS_DIR at the repo migrations folder', async () => {
    const { DEFAULT_MIGRATIONS_DIR } = await import('./migrate.js');
    expect(DEFAULT_MIGRATIONS_DIR).toBe(join(migrationsDir));
  });
});

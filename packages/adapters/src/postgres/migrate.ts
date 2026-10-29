import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../../../migrations/postgres', import.meta.url));

/** Serialises concurrent migrators. */
const ADVISORY_LOCK_KEY = 3_500_000_001;

export interface MigrateOptions {
  pool: pg.Pool;
  dir?: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export function readMigrations(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(dir, file), 'utf8');
      return { version: file.slice(0, 4), name: file, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

/**
 * Apply versioned SQL migrations in order. Safe to run concurrently and repeatedly:
 * a lock serialises runners, applied versions are skipped, and a changed file is refused.
 */
export async function migrate(options: MigrateOptions): Promise<MigrationResult> {
  const files = readMigrations(options.dir ?? DEFAULT_MIGRATIONS_DIR);
  const client = await options.pool.connect();
  const result: MigrationResult = { applied: [], alreadyApplied: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           version    TEXT PRIMARY KEY,
           name       TEXT        NOT NULL,
           checksum   TEXT        NOT NULL,
           applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )`
      );
      const applied = new Map<string, string>();
      for (const row of (await client.query('SELECT version, checksum FROM schema_migrations')).rows) {
        applied.set(String(row.version), String(row.checksum));
      }
      for (const file of files) {
        const existing = applied.get(file.version);
        if (existing !== undefined) {
          if (existing !== file.checksum) {
            throw new Error(`migration ${file.name} was changed after it was applied; add a new migration instead`);
          }
          result.alreadyApplied.push(file.name);
          continue;
        }
        try {
          await client.query('BEGIN');
          await client.query(file.sql);
          await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
            file.version,
            file.name,
            file.checksum,
          ]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw new Error(`migration ${file.name} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        result.applied.push(file.name);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
  return result;
}

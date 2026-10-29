import pg from 'pg';

/** Small Pool for the packet store and migrator. */
export function createPgPool(databaseUrl: string, max = 4): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    max,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });
}

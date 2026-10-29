import { createPgPool } from './pool.js';
import { migrate } from './migrate.js';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error('DATABASE_URL is required to run migrations');
  }
  const pool = createPgPool(url, 2);
  try {
    const result = await migrate({
      pool,
      ...(process.env.CONTEXT_MIGRATIONS_DIR ? { dir: process.env.CONTEXT_MIGRATIONS_DIR } : {}),
    });
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        applied: result.applied,
        alreadyApplied: result.alreadyApplied.length,
      })
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

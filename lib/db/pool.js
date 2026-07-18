import pg from 'pg';

const { Pool } = pg;

export function createPool(env = process.env) {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) return null;

  return new Pool({
    connectionString,
    max: Number(env.DATABASE_POOL_SIZE || 10),
    ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    application_name: 'personal-health-data-hub',
  });
}

export async function databaseReady(pool) {
  if (!pool) return false;
  try {
    await pool.query('SELECT 1');
    const migration = await pool.query(
      `SELECT 1 FROM schema_migrations WHERE filename = '001_initial.sql' LIMIT 1`,
    );
    return migration.rowCount === 1;
  } catch {
    return false;
  }
}

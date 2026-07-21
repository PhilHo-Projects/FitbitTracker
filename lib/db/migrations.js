import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultDirectory = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

function sqlForPool(sql, pool) {
  if (pool.constructor?.name !== 'MemPg') return sql;

  return sql.replace(/\s+INCLUDE\s*\([^;]+\)(?=;)/g, '');
}

export async function applyMigrations(pool, { directory = defaultDirectory } = {}) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const filenames = (await readdir(directory))
    .filter((filename) => filename.endsWith('.sql'))
    .sort();
  const applied = await pool.query('SELECT filename FROM schema_migrations');
  const completed = new Set(applied.rows.map(({ filename }) => filename));
  const executed = [];

  for (const filename of filenames) {
    if (completed.has(filename)) continue;
    const sql = await readFile(path.join(directory, filename), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sqlForPool(sql, pool));
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
      await client.query('COMMIT');
      executed.push(filename);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return executed;
}

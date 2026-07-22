import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultDirectory = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

function sqlForPool(sql, pool) {
  if (pool.constructor?.name !== 'MemPg') return sql;

  return sql.replace(/\s+INCLUDE\s*\([^;]+\)(?=;)/g, '');
}

function quoteIdentifier(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error('Migration schema must be a simple PostgreSQL identifier');
  }

  return `"${identifier}"`;
}

export async function applyMigrations(pool, { directory = defaultDirectory, schema } = {}) {
  const client = await pool.connect();
  try {
    if (schema) await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const filenames = (await readdir(directory))
      .filter((filename) => filename.endsWith('.sql'))
      .sort();
    const applied = await client.query('SELECT filename FROM schema_migrations');
    const completed = new Set(applied.rows.map(({ filename }) => filename));
    const executed = [];

    for (const filename of filenames) {
      if (completed.has(filename)) continue;
      const sql = await readFile(path.join(directory, filename), 'utf8');
      await client.query('BEGIN');
      await client.query(sqlForPool(sql, pool));
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
      await client.query('COMMIT');
      executed.push(filename);
    }

    return executed;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The migration may have failed before its transaction started.
    }
    throw error;
  } finally {
    if (schema && pool.constructor?.name !== 'MemPg') await client.query('RESET search_path');
    client.release();
  }
}

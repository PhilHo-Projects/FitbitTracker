import { changedColumns } from './changed-columns.js';

// Table/column names are internal constants. Keep parameter counts and temporary
// payloads bounded even when a provider returns a full 10,000-record page.
export async function batchUpsert(client, table, columns, records, valuesFor) {
  for (let offset = 0; offset < records.length; offset += 500) {
    // PostgreSQL cannot update the same conflict key twice in one statement.
    // Keep the last correction within each batch, matching sequential ingestion.
    const unique = new Map();
    for (const record of records.slice(offset, offset + 500)) unique.set(record.providerKey, record);
    const values = [...unique.values()].map(valuesFor);
    const tuples = values.map((_, row) => `(${columns.map((_, column) => `$${row * columns.length + column + 1}`).join(',')})`);
    await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')}
      ON CONFLICT (source_account_id, provider_key) DO UPDATE SET
        ${columns.slice(3).map(column => `${column}=EXCLUDED.${column}`).join(',')}, updated_at=CURRENT_TIMESTAMP
      WHERE ${changedColumns(table, columns.slice(3))}`, values.flat());
  }
}

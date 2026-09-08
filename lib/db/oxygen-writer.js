import { deterministicUuid } from './ids.js';

// Column names are internal constants; only values enter SQL from provider records.
const COMMON = ['id', 'source_account_id', 'provider_key', 'provider_id', 'source_key', 'civil_date'];
const SAMPLE_COLUMNS = [...COMMON, 'sampled_at', 'sample_time_text', 'utc_offset_seconds',
  'percentage', 'source_metadata', 'source_fields'];
const DAILY_COLUMNS = [...COMMON, 'average_percentage', 'lower_bound_percentage',
  'upper_bound_percentage', 'standard_deviation_percentage', 'quality_flags', 'source_metadata', 'source_fields'];

function upsertSql(table, columns) {
  return `INSERT INTO ${table} (${columns.join(', ')})
    VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
    ON CONFLICT (source_account_id, provider_key) DO UPDATE SET
      ${columns.slice(3).map(column => `${column} = EXCLUDED.${column}`).join(', ')},
      updated_at = CURRENT_TIMESTAMP`;
}
const SAMPLE_UPSERT = upsertSql('oxygen_saturation_samples', SAMPLE_COLUMNS);
const DAILY_UPSERT = upsertSql('oxygen_saturation_daily_summaries', DAILY_COLUMNS);

export function createOxygenWriter(pool, { clientOwnedByCaller = false } = {}) {
  async function write(sql, rows, values) {
    if (!rows.length) return;
    const client = clientOwnedByCaller ? pool : await pool.connect();
    try {
      if (!clientOwnedByCaller) await client.query('BEGIN');
      for (const row of rows) await client.query(sql, values(row));
      if (!clientOwnedByCaller) await client.query('COMMIT');
    } catch (error) {
      if (!clientOwnedByCaller) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (!clientOwnedByCaller) client.release();
    }
  }
  function common(accountId, row, namespace) {
    return [deterministicUuid(namespace, `${accountId}:${row.providerKey}`), accountId,
      row.providerKey, row.providerId, row.sourceKey, row.civilDate];
  }
  return {
    upsertOxygenSaturationSamples(accountId, rows) {
      return write(SAMPLE_UPSERT, rows, row => [
        ...common(accountId, row, 'oxygen-sample'), row.sampledAt, row.sampledAt,
        row.utcOffsetSeconds, row.percentage, row.sourceMetadata, row.sourceFields,
      ]);
    },
    upsertDailyOxygenSaturation(accountId, rows) {
      return write(DAILY_UPSERT, rows, row => [
        ...common(accountId, row, 'oxygen-daily'), row.averagePercentage,
        row.lowerBoundPercentage, row.upperBoundPercentage, row.standardDeviationPercentage,
        JSON.stringify(row.qualityFlags), row.sourceMetadata, row.sourceFields,
      ]);
    },
  };
}

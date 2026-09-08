import { oxygenDailyRow, oxygenFetchStatus } from '../db/oxygen-repository.js';

const dateOnly = value => typeof value === 'string' ? value.slice(0, 10) : value ? new Date(value).toISOString().slice(0, 10) : null;

export function createOxygenDataset(pool, { batchSize = 2000 } = {}) {
  const memory = pool.constructor?.name === 'MemPg';
  const civilText = memory ? 'civil_date' : 'civil_date::text';
  const timestampText = memory ? 'sampled_at' : `to_char(sampled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const params = (id, range) => [id, range.startDate, range.endDateExclusive];
  return {
    async dailyRows(id, range) {
      return (await pool.query(`SELECT *, ${civilText} AS civil_date_text FROM oxygen_saturation_daily_summaries
        WHERE source_account_id = $1 AND civil_date >= $2 AND civil_date < $3 ORDER BY civil_date, provider_key`, params(id, range))).rows
        .map(row => ({ ...oxygenDailyRow(row), sourceMetadata: row.source_metadata, sourceFields: row.source_fields }));
    },
    async sampleDates(id, range) {
      return (await pool.query(`SELECT ${civilText} AS date FROM oxygen_saturation_samples
        WHERE source_account_id = $1 AND civil_date >= $2 AND civil_date < $3 GROUP BY civil_date ORDER BY civil_date`, params(id, range))).rows.map(row => dateOnly(row.date));
    },
    async *streamSamples(id, range) {
      let cursorTime = null, cursorId = null;
      while (true) {
        const rows = (await pool.query(`SELECT *, ${civilText} AS civil_date_text, ${timestampText} AS cursor_time FROM oxygen_saturation_samples
          WHERE source_account_id = $1 AND civil_date >= $2 AND civil_date < $3
          AND ($4::timestamptz IS NULL OR sampled_at > $4::timestamptz OR (sampled_at = $4::timestamptz AND id > $5::uuid))
          ORDER BY sampled_at, id LIMIT $6`, [...params(id, range), cursorTime, cursorId, batchSize])).rows;
        for (const row of rows) yield { providerKey: row.provider_key, providerId: row.provider_id, sourceKey: row.source_key,
          civilDate: dateOnly(row.civil_date_text), sampledAt: row.sample_time_text, utcOffsetSeconds: Number(row.utc_offset_seconds),
          percentage: Number(row.percentage), sourceMetadata: row.source_metadata, sourceFields: row.source_fields };
        if (rows.length < batchSize) break;
        const last = rows.at(-1);
        cursorTime = last.cursor_time; cursorId = last.id;
      }
    },
    async availability(id, range) {
      const [counts, chunks] = await Promise.all([
        pool.query(`SELECT COUNT(*) AS count, MIN(civil_date) AS first_date, MAX(civil_date) AS last_date
          FROM oxygen_saturation_samples WHERE source_account_id = $1 AND civil_date >= $2 AND civil_date < $3`, params(id, range)),
        pool.query(`SELECT c.*, j.created_at AS job_created_at FROM sync_chunks c JOIN sync_jobs j ON j.id = c.sync_job_id
          WHERE j.source_account_id = $1 AND c.metric = 'oxygen-saturation' AND c.start_date < $3 AND c.end_date_exclusive > $2`, params(id, range)),
      ]);
      const fetch = oxygenFetchStatus(chunks.rows, range);
      return { sampleCount: Number(counts.rows[0].count), firstCivilDate: dateOnly(counts.rows[0].first_date), lastCivilDate: dateOnly(counts.rows[0].last_date),
        coldArchiveSupported: false, ...fetch };
    },
  };
}

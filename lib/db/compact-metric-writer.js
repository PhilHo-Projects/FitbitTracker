import { deterministicUuid } from './ids.js';
import {
  canonicalizeSourceMetadata,
  hashSourceMetadata,
  sourceMetadataForRecord,
} from '../metrics/source-metadata.js';

const calorieDataTypes = {
  total: 'total-calories',
  active: 'active-energy-burned',
  basal: 'basal-energy-burned',
};

function insertedRow(row) {
  return row.inserted === true || row.inserted === 't';
}

function writeCounts(inputCount, result) {
  const inserted = result.rows.filter(insertedRow).length;
  const updated = result.rows.length - inserted;
  return { inserted, updated, unchanged: inputCount - inserted - updated };
}

function assertUnique(rows, keyFor, label) {
  const keys = new Set();
  for (const row of rows) {
    const key = keyFor(row);
    if (keys.has(key)) throw new Error(`Duplicate ${label} semantic identity: ${key}`);
    keys.add(key);
  }
}

export function createCompactMetricWriter(pool) {
  async function resolveRows(sourceAccountId, records, dataTypeFor) {
    const streams = new Map();
    const resolved = [];
    for (const record of records) {
      const metadata = canonicalizeSourceMetadata(
        record.sourceMetadata ?? sourceMetadataForRecord(record, dataTypeFor(record)),
      );
      const metadataHash = hashSourceMetadata(metadata);
      let sourceStreamId = streams.get(metadataHash);
      if (!sourceStreamId) {
        const generatedId = deterministicUuid(
          'source-stream',
          `${sourceAccountId}:${metadataHash}`,
        );
        const inserted = await pool.query(
          `INSERT INTO source_streams (id, source_account_id, metadata, metadata_hash)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (source_account_id, metadata_hash) DO NOTHING
           RETURNING id`,
          [generatedId, sourceAccountId, metadata, metadataHash],
        );
        sourceStreamId = inserted.rows[0]?.id;
        if (!sourceStreamId) {
          sourceStreamId = (
            await pool.query(
              `SELECT id FROM source_streams
               WHERE source_account_id = $1 AND metadata_hash = $2`,
              [sourceAccountId, metadataHash],
            )
          ).rows[0]?.id;
        }
        if (!sourceStreamId) throw new Error('Source stream could not be resolved');
        streams.set(metadataHash, sourceStreamId);
      }
      resolved.push({ ...record, sourceStreamId });
    }
    return resolved;
  }

  return {
    async upsertHeartSamples(sourceAccountId, samples) {
      if (!samples.length) return { inserted: 0, updated: 0, unchanged: 0 };
      const rows = await resolveRows(sourceAccountId, samples, () => 'heart-rate');
      assertUnique(
        rows,
        ({ sourceStreamId, sampledAt }) => `${sourceStreamId}:${new Date(sampledAt).toISOString()}`,
        'heart',
      );
      const payload = rows.map((sample) => ({
        sourceStreamId: sample.sourceStreamId,
        civilDate: sample.civilDate,
        sampledAt: sample.sampledAt,
        utcOffsetSeconds: sample.utcOffsetSeconds ?? null,
        beatsPerMinute: sample.beatsPerMinute,
        upstreamSampleId: sample.providerId ?? null,
      }));
      const result = await pool.query(
        `WITH incoming AS (
           SELECT $1::uuid AS source_account_id,
             value."sourceStreamId"::uuid AS source_stream_id,
             value."civilDate"::date AS civil_date,
             value."sampledAt"::timestamptz AS sampled_at,
             value."utcOffsetSeconds"::integer AS utc_offset_seconds,
             value."beatsPerMinute"::numeric AS beats_per_minute,
             value."upstreamSampleId"::text AS upstream_sample_id
           FROM jsonb_to_recordset($2::jsonb) AS value(
             "sourceStreamId" text, "civilDate" text, "sampledAt" text,
             "utcOffsetSeconds" integer, "beatsPerMinute" numeric, "upstreamSampleId" text
           )
         )
         INSERT INTO heart_rate_samples_compact AS existing (
           source_account_id, source_stream_id, civil_date, sampled_at,
           utc_offset_seconds, beats_per_minute, upstream_sample_id
         )
         SELECT source_account_id, source_stream_id, civil_date, sampled_at,
           utc_offset_seconds, beats_per_minute, upstream_sample_id
         FROM incoming
         ON CONFLICT (source_stream_id, sampled_at) DO UPDATE SET
           source_account_id = EXCLUDED.source_account_id,
           civil_date = EXCLUDED.civil_date,
           utc_offset_seconds = EXCLUDED.utc_offset_seconds,
           beats_per_minute = EXCLUDED.beats_per_minute,
           upstream_sample_id = EXCLUDED.upstream_sample_id,
           updated_at = CURRENT_TIMESTAMP
         WHERE (existing.source_account_id, existing.civil_date, existing.utc_offset_seconds,
                existing.beats_per_minute, existing.upstream_sample_id)
           IS DISTINCT FROM
               (EXCLUDED.source_account_id, EXCLUDED.civil_date, EXCLUDED.utc_offset_seconds,
                EXCLUDED.beats_per_minute, EXCLUDED.upstream_sample_id)
         RETURNING (xmax = 0) AS inserted`,
        [sourceAccountId, JSON.stringify(payload)],
      );
      return writeCounts(payload.length, result);
    },

    async upsertCalorieIntervals(sourceAccountId, intervals) {
      if (!intervals.length) return { inserted: 0, updated: 0, unchanged: 0 };
      const rows = await resolveRows(
        sourceAccountId,
        intervals,
        ({ metricType }) => calorieDataTypes[metricType] ?? `calories:${metricType}`,
      );
      assertUnique(
        rows,
        ({ sourceStreamId, metricType, startTime }) =>
          `${sourceStreamId}:${metricType}:${new Date(startTime).toISOString()}`,
        'calorie',
      );
      const payload = rows.map((interval) => ({
        sourceStreamId: interval.sourceStreamId,
        civilDate: interval.civilDate,
        intervalType: interval.metricType,
        startAt: interval.startTime,
        endAt: interval.endTime,
        utcOffsetSeconds: interval.utcOffsetSeconds ?? null,
        kilocalories: interval.kilocalories,
        upstreamSampleId: interval.providerId ?? null,
      }));
      const result = await pool.query(
        `WITH incoming AS (
           SELECT $1::uuid AS source_account_id,
             value."sourceStreamId"::uuid AS source_stream_id,
             value."civilDate"::date AS civil_date,
             value."intervalType"::text AS interval_type,
             value."startAt"::timestamptz AS start_at,
             value."endAt"::timestamptz AS end_at,
             value."utcOffsetSeconds"::integer AS utc_offset_seconds,
             value.kilocalories::numeric AS kilocalories,
             value."upstreamSampleId"::text AS upstream_sample_id
           FROM jsonb_to_recordset($2::jsonb) AS value(
             "sourceStreamId" text, "civilDate" text, "intervalType" text,
             "startAt" text, "endAt" text, "utcOffsetSeconds" integer,
             kilocalories numeric, "upstreamSampleId" text
           )
         )
         INSERT INTO calorie_intervals_compact AS existing (
           source_account_id, source_stream_id, civil_date, interval_type, start_at,
           end_at, utc_offset_seconds, kilocalories, upstream_sample_id
         )
         SELECT source_account_id, source_stream_id, civil_date, interval_type, start_at,
           end_at, utc_offset_seconds, kilocalories, upstream_sample_id
         FROM incoming
         ON CONFLICT (source_stream_id, interval_type, start_at) DO UPDATE SET
           source_account_id = EXCLUDED.source_account_id,
           civil_date = EXCLUDED.civil_date,
           end_at = EXCLUDED.end_at,
           utc_offset_seconds = EXCLUDED.utc_offset_seconds,
           kilocalories = EXCLUDED.kilocalories,
           upstream_sample_id = EXCLUDED.upstream_sample_id,
           updated_at = CURRENT_TIMESTAMP
         WHERE (existing.source_account_id, existing.civil_date, existing.end_at,
                existing.utc_offset_seconds, existing.kilocalories, existing.upstream_sample_id)
           IS DISTINCT FROM
               (EXCLUDED.source_account_id, EXCLUDED.civil_date, EXCLUDED.end_at,
                EXCLUDED.utc_offset_seconds, EXCLUDED.kilocalories, EXCLUDED.upstream_sample_id)
         RETURNING (xmax = 0) AS inserted`,
        [sourceAccountId, JSON.stringify(payload)],
      );
      return writeCounts(payload.length, result);
    },
  };
}

import { SLEEP_VITALS } from "../metrics/sleep-vitals.js";
import { deterministicUuid } from "./ids.js";

export function createSleepVitalsWriter(
  pool,
  { clientOwnedByCaller = false } = {},
) {
  return {
    async upsertSleepVitals(accountId, metric, rows) {
      const spec = SLEEP_VITALS[metric];
      if (!spec) throw new Error("Unsupported sleep vital");
      if (!rows.length) return;
      const columns = [
        "id",
        "source_account_id",
        "provider_key",
        "provider_id",
        "source_key",
        "civil_date",
        ...(!spec.daily
          ? ["sampled_at", "sample_time_text", "utc_offset_seconds"]
          : []),
        ...Object.keys(spec.fields),
        "source_metadata",
        "source_fields",
      ];
      const sql = `INSERT INTO ${spec.table} (${columns.join(",")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(",")})
      ON CONFLICT(source_account_id,provider_key) DO UPDATE SET ${columns
        .slice(3)
        .map((c) => `${c}=EXCLUDED.${c}`)
        .join(",")}, updated_at=CURRENT_TIMESTAMP`;
      const client = clientOwnedByCaller ? pool : await pool.connect();
      try {
        if (!clientOwnedByCaller) await client.query("BEGIN");
        for (const row of rows)
          await client.query(sql, [
            deterministicUuid(metric, `${accountId}:${row.providerKey}`),
            accountId,
            row.providerKey,
            row.providerId,
            row.sourceKey,
            row.civilDate,
            ...(!spec.daily
              ? [row.sampledAt, row.sampledAt, row.utcOffsetSeconds]
              : []),
            ...Object.keys(spec.fields).map((k) => row[k]),
            row.sourceMetadata,
            row.sourceFields,
          ]);
        if (!clientOwnedByCaller) await client.query("COMMIT");
      } catch (error) {
        if (!clientOwnedByCaller) await client.query("ROLLBACK");
        throw error;
      } finally {
        if (!clientOwnedByCaller) client.release();
      }
    },
  };
}

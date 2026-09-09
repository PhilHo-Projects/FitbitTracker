import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { newDb } from "pg-mem";
import { applyMigrations } from "../lib/db/migrations.js";
import { createJournalCipher } from "../lib/journal/crypto.js";

test("check-ins preserve unanswered fields, encrypt context, upsert by date, and delete independently", async () => {
  const { createSleepCheckInRepository } = await import(
    "../lib/sleep/check-ins.js"
  );
  const pool = new (newDb({
    noAstCoverageCheck: true,
  }).adapters.createPg().Pool)();
  await applyMigrations(pool);
  await pool.query(
    `INSERT INTO source_accounts(id,provider,provider_account_id) VALUES('75ce6554-70c7-48be-a688-d0079384fcb1','google-health','test')`,
  );
  const cipher = createJournalCipher(
    `1:${crypto.randomBytes(32).toString("base64")}`,
  );
  const repo = createSleepCheckInRepository(pool, cipher);
  assert.equal(await repo.get("2026-09-08"), null);
  await repo.put("2026-09-08", {
    restfulness: 2,
    note: "private bedroom note",
    context: ["heat"],
  });
  const row = (await pool.query("SELECT * FROM sleep_check_ins")).rows[0];
  assert.ok(!JSON.stringify(row).includes("bedroom"));
  assert.equal((await repo.get("2026-09-08")).awakenings, null);
  await repo.put("2026-09-08", { restfulness: 4, awakenings: 0 });
  assert.equal((await repo.list("2026-09-01", "2026-10-01")).length, 1);
  await assert.rejects(() => repo.put("2026-02-30", { restfulness: 4 }));
  await assert.rejects(() => repo.put("2026-09-08", { restfulness: 6 }));
  await repo.remove("2026-09-08");
  assert.equal(await repo.get("2026-09-08"), null);
  await pool.end();
});

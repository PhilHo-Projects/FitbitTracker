import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createApp } from "../server.js";
import { createTestAuth, signInCookie } from "../test-support/auth.js";

test("sleep APIs require auth, prevent foreign-origin writes, validate dates and isolate encrypted check-ins", async () => {
  const env = {
    NODE_ENV: "test",
    DASHBOARD_SESSION_SECRET: "test-session-secret-that-is-long-enough",
    JOURNAL_ENCRYPTION_KEYS: `1:${randomBytes(32).toString("base64")}`,
  };
  const { auth, pool } = await createTestAuth(env);
  await pool.query(
    "INSERT INTO source_accounts(id,provider,provider_account_id) VALUES('75ce6554-70c7-48be-a688-d0079384fcb1','google-health','test')",
  );
  const server = http.createServer(createApp({ env, pool, auth }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/sleep/report`)).status, 401);
    const cookie = await signInCookie(base),
      headers = { cookie, origin: base, "content-type": "application/json" };
    const request = (path, method = "GET", body) =>
      fetch(`${base}/api/sleep/${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const preferences = await request("preferences");
    assert.equal(preferences.headers.get("cache-control"), "no-store");
    assert.equal((await preferences.json()).data.goalMinutes, 420);
    assert.equal(
      (await request("preferences", "PUT", { goalMinutes: 450 })).status,
      200,
    );
    assert.equal(
      (await request("preferences", "PUT", { goalMinutes: 0 })).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${base}/api/sleep/preferences`, {
          method: "PUT",
          headers: { ...headers, origin: "https://foreign.invalid" },
          body: JSON.stringify({ goalMinutes: 480 }),
        })
      ).status,
      403,
    );
    assert.equal((await request("check-ins/2026-02-30")).status, 400);
    assert.equal(
      (await request("check-ins/2026-09-08").then((r) => r.json())).data,
      null,
    );
    await request("check-ins/2026-09-08", "PUT", {
      restfulness: 3,
      note: "private context",
    });
    const row = (await pool.query("SELECT * FROM sleep_check_ins")).rows[0];
    assert.equal(JSON.stringify(row).includes("private context"), false);
    const report = await request("report?date=2026-09-08");
    assert.equal(report.headers.get("cache-control"), "no-store");
    assert.equal(
      JSON.stringify(await report.json()).includes("private context"),
      false,
    );
    assert.equal(
      (
        await request("check-ins?start=2026-09-01&end=2026-10-01").then((r) =>
          r.json(),
        )
      ).data.length,
      1,
    );
    await request("check-ins/2026-09-08", "DELETE");
    assert.equal(
      (await request("check-ins/2026-09-08").then((r) => r.json())).data,
      null,
    );
  } finally {
    server.close();
    await once(server, "close");
    await pool.end();
  }
});

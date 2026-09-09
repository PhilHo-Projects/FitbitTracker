import { oxygenCivilDate } from "../metrics/oxygen-time.js";

export const CHECK_IN_CONTEXT = [
  "illness",
  "stress",
  "late meal",
  "caffeine",
  "alcohol",
  "travel",
  "heat",
  "noise",
];
export function sleepDate(value) {
  try {
    return oxygenCivilDate(value);
  } catch {
    throw Object.assign(new Error("Date must be a valid YYYY-MM-DD date"), {
      status: 400,
    });
  }
}
export function sleepRange(start, end) {
  sleepDate(start);
  sleepDate(end);
  if (start >= end || (Date.parse(end) - Date.parse(start)) / 86400000 > 366) {
    throw Object.assign(
      new Error("Choose a date range of 1–366 days; end is exclusive"),
      { status: 400 },
    );
  }
}
function validate(input) {
  const {
    restfulness = null,
    awakenings = null,
    context = [],
    note = "",
  } = input ?? {};
  if (
    (restfulness !== null && ![1, 2, 3, 4, 5].includes(restfulness)) ||
    (awakenings !== null && ![0, 1, 2, 3].includes(awakenings)) ||
    !Array.isArray(context) ||
    context.some((x) => !CHECK_IN_CONTEXT.includes(x)) ||
    typeof note !== "string" ||
    note.length > 2000
  ) {
    throw Object.assign(new Error("Invalid sleep check-in"), { status: 400 });
  }
  return {
    restfulness,
    awakenings,
    context: [...new Set(context)],
    note: note.trim(),
  };
}
export function createSleepCheckInRepository(pool, cipher) {
  async function account() {
    return (
      await pool.query(
        "SELECT id FROM source_accounts ORDER BY created_at LIMIT 1",
      )
    ).rows[0]?.id;
  }
  function hydrate(row) {
    if (!row) return null;
    const body = JSON.parse(
      cipher.decrypt({
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        authTag: row.auth_tag,
        keyVersion: row.key_version,
      }),
    );
    return {
      ...body,
      date:
        typeof row.civil_date === "string"
          ? row.civil_date.slice(0, 10)
          : row.civil_date.toISOString().slice(0, 10),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }
  return {
    async get(date) {
      sleepDate(date);
      return hydrate(
        (
          await pool.query(
            "SELECT * FROM sleep_check_ins WHERE source_account_id = $1 AND civil_date = $2",
            [await account(), date],
          )
        ).rows[0],
      );
    },
    async list(start, end) {
      sleepRange(start, end);
      return (
        await pool.query(
          "SELECT * FROM sleep_check_ins WHERE source_account_id = $1 AND civil_date >= $2 AND civil_date < $3 ORDER BY civil_date",
          [await account(), start, end],
        )
      ).rows.map(hydrate);
    },
    async put(date, input) {
      sleepDate(date);
      const body = validate(input),
        id = await account();
      if (!id)
        throw Object.assign(new Error("Connect a source account first"), {
          status: 409,
        });
      const encrypted = cipher.encrypt(JSON.stringify(body));
      const row = (
        await pool.query(
          `INSERT INTO sleep_check_ins (source_account_id, civil_date, ciphertext, nonce, auth_tag, key_version)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (source_account_id,civil_date) DO UPDATE SET
        ciphertext=EXCLUDED.ciphertext, nonce=EXCLUDED.nonce, auth_tag=EXCLUDED.auth_tag, key_version=EXCLUDED.key_version, updated_at=CURRENT_TIMESTAMP RETURNING *`,
          [
            id,
            date,
            encrypted.ciphertext.toString("base64"),
            encrypted.nonce.toString("base64"),
            encrypted.authTag.toString("base64"),
            encrypted.keyVersion,
          ],
        )
      ).rows[0];
      return hydrate(row);
    },
    async remove(date) {
      sleepDate(date);
      await pool.query(
        "DELETE FROM sleep_check_ins WHERE source_account_id = $1 AND civil_date = $2",
        [await account(), date],
      );
    },
  };
}

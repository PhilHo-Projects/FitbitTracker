import crypto from 'node:crypto';

function normalizeTags(tags) {
  const unique = new Map();
  for (const tag of Array.isArray(tags) ? tags : []) {
    const name = String(tag || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    const normalized = name.toLocaleLowerCase('en-CA');
    if (name && !unique.has(normalized)) unique.set(normalized, name);
  }
  return [...unique.entries()].map(([normalizedName, name]) => ({ normalizedName, name }));
}

function dateOnly(value) {
  return typeof value === 'string' ? value.slice(0, 10) : new Date(value).toISOString().slice(0, 10);
}

function iso(value) {
  return new Date(value).toISOString();
}

function encryptedRow(encrypted) {
  return [
    encrypted.ciphertext.toString('base64'),
    encrypted.nonce.toString('base64'),
    encrypted.authTag.toString('base64'),
    encrypted.keyVersion,
  ];
}

export function createJournalRepository(pool, cipher) {
  async function sourceAccount(client = pool) {
    const row = (await client.query('SELECT id FROM source_accounts ORDER BY created_at LIMIT 1')).rows[0];
    if (!row) throw new Error('No source account is configured');
    return row.id;
  }

  async function replaceTags(client, sourceAccountId, entryId, tags) {
    await client.query('DELETE FROM journal_entry_tags WHERE journal_entry_id = $1', [entryId]);
    for (const tag of normalizeTags(tags)) {
      const id = crypto.randomUUID();
      const result = await client.query(
        `INSERT INTO journal_tags (id, source_account_id, name, normalized_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (source_account_id, normalized_name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [id, sourceAccountId, tag.name, tag.normalizedName],
      );
      await client.query(
        `INSERT INTO journal_entry_tags (journal_entry_id, journal_tag_id)
         VALUES ($1, $2)
         ON CONFLICT (journal_entry_id, journal_tag_id) DO NOTHING`,
        [entryId, result.rows[0].id],
      );
    }
  }

  async function tagsFor(entryId, client = pool) {
    const result = await client.query(
      `SELECT tag.name
       FROM journal_tags tag
       JOIN journal_entry_tags link ON link.journal_tag_id = tag.id
       WHERE link.journal_entry_id = $1
       ORDER BY tag.name`,
      [entryId],
    );
    return result.rows.map(({ name }) => name);
  }

  async function hydrate(row, client = pool) {
    return {
      id: row.id,
      civilDate: dateOnly(row.civil_date),
      occurredAt: iso(row.occurred_at),
      body: cipher.decrypt({
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        authTag: row.auth_tag,
        keyVersion: row.key_version,
      }),
      tags: await tagsFor(row.id, client),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  return {
    async create({ civilDate, occurredAt, body, tags = [] }) {
      if (!String(body || '').trim()) throw new Error('Journal body is required');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const sourceAccountId = await sourceAccount(client);
        const id = crypto.randomUUID();
        const encrypted = cipher.encrypt(String(body).trim());
        const [ciphertext, nonce, authTag, keyVersion] = encryptedRow(encrypted);
        const result = await client.query(
          `INSERT INTO journal_entries (
            id, source_account_id, civil_date, occurred_at, ciphertext, nonce, auth_tag, key_version
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING *`,
          [id, sourceAccountId, civilDate, occurredAt, ciphertext, nonce, authTag, keyVersion],
        );
        await replaceTags(client, sourceAccountId, id, tags);
        const entry = await hydrate(result.rows[0], client);
        await client.query('COMMIT');
        return entry;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async list({ startDate, endDateExclusive }) {
      const sourceAccountId = await sourceAccount();
      const result = await pool.query(
        `SELECT *
         FROM journal_entries
         WHERE source_account_id = $1
           AND civil_date >= $2
           AND civil_date < $3
           AND deleted_at IS NULL
         ORDER BY occurred_at DESC`,
        [sourceAccountId, startDate, endDateExclusive],
      );
      return Promise.all(result.rows.map((row) => hydrate(row)));
    },

    async update(id, { body, tags = [] }) {
      if (!String(body || '').trim()) throw new Error('Journal body is required');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const sourceAccountId = await sourceAccount(client);
        const current = (
          await client.query(
            `SELECT * FROM journal_entries
             WHERE id = $1 AND source_account_id = $2 AND deleted_at IS NULL`,
            [id, sourceAccountId],
          )
        ).rows[0];
        if (!current) throw new Error('Journal entry not found');
        const revisionNumber = Number(
          (
            await client.query(
              `SELECT COUNT(*) AS count FROM journal_entry_revisions WHERE journal_entry_id = $1`,
              [id],
            )
          ).rows[0].count,
        ) + 1;
        await client.query(
          `INSERT INTO journal_entry_revisions (
            id, journal_entry_id, revision_number, ciphertext, nonce, auth_tag, key_version
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            crypto.randomUUID(),
            id,
            revisionNumber,
            current.ciphertext,
            current.nonce,
            current.auth_tag,
            current.key_version,
          ],
        );
        const encrypted = cipher.encrypt(String(body).trim());
        const [ciphertext, nonce, authTag, keyVersion] = encryptedRow(encrypted);
        const result = await client.query(
          `UPDATE journal_entries
           SET ciphertext = $1, nonce = $2, auth_tag = $3, key_version = $4,
             updated_at = CURRENT_TIMESTAMP
           WHERE id = $5
           RETURNING *`,
          [ciphertext, nonce, authTag, keyVersion, id],
        );
        await replaceTags(client, sourceAccountId, id, tags);
        const entry = await hydrate(result.rows[0], client);
        await client.query('COMMIT');
        return entry;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async remove(id) {
      const sourceAccountId = await sourceAccount();
      const result = await pool.query(
        `UPDATE journal_entries
         SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND source_account_id = $2 AND deleted_at IS NULL`,
        [id, sourceAccountId],
      );
      if (!result.rowCount) throw new Error('Journal entry not found');
      return { id, deleted: true };
    },
  };
}

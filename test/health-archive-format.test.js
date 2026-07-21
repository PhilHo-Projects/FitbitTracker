import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseArchiveConfig } from '../lib/archive/config.js';
import {
  createArchiveEnvelope,
  decryptArchiveEnvelope,
  inspectArchiveEnvelope,
} from '../lib/archive/format.js';
import { isArchiveMonthEligible } from '../lib/archive/service.js';

const keyOne = Buffer.alloc(32, 1).toString('base64');
const keyTwo = Buffer.alloc(32, 2).toString('base64');

test('disabled archive configuration is lazy and defaults pruning off', () => {
  assert.deepEqual(parseArchiveConfig({}), {
    enabled: false,
    pruningEnabled: false,
    region: 'auto',
  });
});

test('enabled and explicitly requested archive configuration validates S3 and versioned AES keys', () => {
  const configured = parseArchiveConfig({
    HEALTH_ARCHIVE_ENABLED: 'true',
    HEALTH_ARCHIVE_S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
    HEALTH_ARCHIVE_S3_BUCKET: 'private-health',
    HEALTH_ARCHIVE_S3_ACCESS_KEY_ID: 'access-id',
    HEALTH_ARCHIVE_S3_SECRET_ACCESS_KEY: 'secret-key',
    HEALTH_ARCHIVE_ENCRYPTION_KEYS: `1:${keyOne},2:${keyTwo}`,
    HEALTH_RAW_PRUNING_ENABLED: 'true',
  });

  assert.equal(configured.enabled, true);
  assert.equal(configured.pruningEnabled, true);
  assert.equal(configured.region, 'auto');
  assert.equal(configured.currentKeyVersion, 2);
  assert.equal(configured.encryptionKeys.get(1).length, 32);

  assert.throws(
    () => parseArchiveConfig({ HEALTH_ARCHIVE_ENCRYPTION_KEYS: `1:${keyOne}` }, { required: true }),
    /HEALTH_ARCHIVE_S3_ENDPOINT/,
  );
  assert.throws(
    () => parseArchiveConfig({
      HEALTH_ARCHIVE_S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
      HEALTH_ARCHIVE_S3_BUCKET: 'private-health',
      HEALTH_ARCHIVE_S3_ACCESS_KEY_ID: 'access-id',
      HEALTH_ARCHIVE_S3_SECRET_ACCESS_KEY: 'secret-key',
      HEALTH_ARCHIVE_ENCRYPTION_KEYS: '1:dG9vLXNob3J0',
    }, { required: true }),
    /exactly 32 bytes/,
  );
});

test('a month is eligible only when its final civil date is at least 90 days old', () => {
  assert.equal(isArchiveMonthEligible('2026-01-01', new Date('2026-05-01T00:00:00Z')), true);
  assert.equal(isArchiveMonthEligible('2026-02-01', new Date('2026-05-01T23:59:59Z')), false);
  assert.throws(() => isArchiveMonthEligible('2026-01-02', new Date()), /first civil date/);
});

test('archive envelope round-trips and authenticates its versioned header', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'health-archive-format-'));
  const plaintextPath = path.join(directory, 'bundle.gz');
  const archivePath = path.join(directory, 'month.hharchive');
  const decryptedPath = path.join(directory, 'restored.gz');
  const plaintext = Buffer.from('deterministic compressed archive bytes');
  await writeFile(plaintextPath, plaintext);

  try {
    const encrypted = await createArchiveEnvelope({
      inputPath: plaintextPath,
      outputPath: archivePath,
      encryptionKeys: new Map([[1, Buffer.alloc(32, 1)]]),
      keyVersion: 1,
      sourceAccountId: '11111111-1111-1111-1111-111111111111',
      archiveMonth: '2026-01-01',
      nonce: Buffer.alloc(12, 9),
    });
    const inspected = await inspectArchiveEnvelope(archivePath);
    const decrypted = await decryptArchiveEnvelope({
      inputPath: archivePath,
      outputPath: decryptedPath,
      encryptionKeys: new Map([[1, Buffer.alloc(32, 1)]]),
    });

    assert.equal(inspected.header.envelopeVersion, 1);
    assert.equal(inspected.header.archiveMonth, '2026-01-01');
    assert.equal(inspected.header.encryptionKeyVersion, 1);
    assert.equal(encrypted.plaintextHash, decrypted.plaintextHash);
    assert.equal(encrypted.ciphertextHash, inspected.ciphertextHash);
    assert.deepEqual(await readFile(decryptedPath), plaintext);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('wrong keys and tampering fail authentication without leaving plaintext', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'health-archive-auth-'));
  const plaintextPath = path.join(directory, 'bundle.gz');
  const archivePath = path.join(directory, 'month.hharchive');
  const wrongOutput = path.join(directory, 'wrong.gz');
  const tamperedOutput = path.join(directory, 'tampered.gz');
  await writeFile(plaintextPath, 'sensitive health data');

  try {
    await createArchiveEnvelope({
      inputPath: plaintextPath,
      outputPath: archivePath,
      encryptionKeys: new Map([[1, Buffer.alloc(32, 1)]]),
      keyVersion: 1,
      sourceAccountId: '11111111-1111-1111-1111-111111111111',
      archiveMonth: '2026-01-01',
      nonce: Buffer.alloc(12, 8),
    });
    await assert.rejects(
      decryptArchiveEnvelope({
        inputPath: archivePath,
        outputPath: wrongOutput,
        encryptionKeys: new Map([[1, Buffer.alloc(32, 2)]]),
      }),
      /authentication failed/,
    );
    await assert.rejects(readFile(wrongOutput), /ENOENT/);

    const tampered = await readFile(archivePath);
    tampered[tampered.length - 17] ^= 1;
    await writeFile(archivePath, tampered);
    await assert.rejects(
      decryptArchiveEnvelope({
        inputPath: archivePath,
        outputPath: tamperedOutput,
        encryptionKeys: new Map([[1, Buffer.alloc(32, 1)]]),
      }),
      /authentication failed/,
    );
    await assert.rejects(readFile(tamperedOutput), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

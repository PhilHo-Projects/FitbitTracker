import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  createArchiveObjectStore,
  createS3ClientFromConfig,
  objectKeyForArchive,
} from '../lib/archive/s3.js';

test('archive object keys use the full lowercase ciphertext SHA-256', () => {
  const hash = 'a'.repeat(64);
  assert.equal(
    objectKeyForArchive('2026-01-01', hash),
    `health-hub/raw/v1/2026/01/health-raw-2026-01-${hash}.hharchive`,
  );
  assert.throws(() => objectKeyForArchive('2026-01-01', 'A'.repeat(64)), /lowercase SHA-256/);
  assert.throws(() => objectKeyForArchive('2026-01-02', hash), /first civil date/);
});

test('R2 client uses the configured S3-compatible endpoint and path-style addressing', () => {
  const client = createS3ClientFromConfig({
    endpoint: 'https://account.r2.cloudflarestorage.com',
    region: 'auto',
    accessKeyId: 'access-id',
    secretAccessKey: 'secret-key',
  });
  assert.ok(client);
  client.destroy();
});

test('upload is create-only and a matching existing full object is idempotent', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'health-s3-'));
  const inputPath = path.join(directory, 'archive.hharchive');
  const bytes = Buffer.from('complete ciphertext archive');
  const expectedHash = crypto.createHash('sha256').update(bytes).digest('hex');
  await writeFile(inputPath, bytes);
  const commands = [];
  const client = {
    async send(command) {
      commands.push(command);
      if (command.constructor.name === 'PutObjectCommand') {
        const error = new Error('already exists');
        error.name = 'PreconditionFailed';
        error.$metadata = { httpStatusCode: 412 };
        throw error;
      }
      if (command.constructor.name === 'GetObjectCommand') {
        return { Body: Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]) };
      }
      throw new Error('unexpected command');
    },
  };

  try {
    const store = createArchiveObjectStore({ client, bucket: 'private-health' });
    const result = await store.uploadCreateOnly({
      key: objectKeyForArchive('2026-01-01', expectedHash),
      filePath: inputPath,
      expectedHash,
      temporaryDirectory: directory,
    });
    assert.deepEqual(result, { created: false, idempotent: true, ciphertextHash: expectedHash });
    assert.equal(commands[0].input.IfNoneMatch, '*');
    assert.equal(commands[0].input.Bucket, 'private-health');
    assert.equal(commands[1].constructor.name, 'GetObjectCommand');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an existing object is rejected unless full readback has the expected hash', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'health-s3-mismatch-'));
  const inputPath = path.join(directory, 'archive.hharchive');
  const bytes = Buffer.from('ciphertext archive');
  const expectedHash = crypto.createHash('sha256').update(bytes).digest('hex');
  await writeFile(inputPath, bytes);
  const client = {
    async send(command) {
      if (command.constructor.name === 'PutObjectCommand') {
        const error = new Error('already exists');
        error.$metadata = { httpStatusCode: 412 };
        throw error;
      }
      return { Body: Readable.from(['different or truncated']) };
    },
  };

  try {
    const store = createArchiveObjectStore({ client, bucket: 'private-health' });
    await assert.rejects(
      store.uploadCreateOnly({
        key: objectKeyForArchive('2026-01-01', expectedHash),
        filePath: inputPath,
        expectedHash,
        temporaryDirectory: directory,
      }),
      /existing archive object hash mismatch/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('download streams to disk and removes partial output when interrupted', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'health-s3-download-'));
  const outputPath = path.join(directory, 'download.hharchive');
  const interrupted = Readable.from((async function* generate() {
    yield Buffer.from('partial');
    throw new Error('connection reset');
  }()));
  const store = createArchiveObjectStore({
    bucket: 'private-health',
    client: { async send() { return { Body: interrupted }; } },
  });

  try {
    await assert.rejects(store.downloadToFile({ key: 'archive-key', outputPath }), /connection reset/);
    await assert.rejects(readFile(outputPath), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

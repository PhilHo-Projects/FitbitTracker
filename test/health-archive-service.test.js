import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createHealthArchiveService } from '../lib/archive/service.js';

const sourceAccountId = '11111111-1111-1111-1111-111111111111';
const archiveMonth = '2026-01-01';
const hash = 'a'.repeat(64);

function catalog(state = 'pending', overrides = {}) {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    source_account_id: sourceAccountId,
    archive_month: archiveMonth,
    archive_version: 1,
    state,
    object_key: state === 'pending' ? null : `health-hub/raw/v1/2026/01/health-raw-2026-01-${hash}.hharchive`,
    ciphertext_hash: state === 'pending' ? null : hash,
    plaintext_hash: state === 'pending' ? null : 'b'.repeat(64),
    byte_size: state === 'pending' ? null : 123,
    heart_sample_count: state === 'pending' ? 0 : 2,
    calorie_interval_count: state === 'pending' ? 0 : 1,
    encryption_key_version: state === 'pending' ? null : 1,
    ...overrides,
  };
}

function repositoryFor(initial) {
  let current = { ...initial };
  const events = [];
  return {
    events,
    get current() { return current; },
    async withMonthLock(_source, _month, callback) { return callback(this); },
    async reserveMonth() { events.push('reserve'); return current; },
    async markBuilding() { events.push('building'); current = { ...current, state: 'building' }; return current; },
    async recordBuilt(_id, built) {
      events.push('built');
      current = {
        ...current,
        ...built,
        object_key: built.objectKey,
        ciphertext_hash: built.ciphertextHash,
        plaintext_hash: built.plaintextHash,
        byte_size: built.byteSize,
        heart_sample_count: built.heartSampleCount,
        calorie_interval_count: built.calorieIntervalCount,
        encryption_key_version: built.encryptionKeyVersion,
      };
      return current;
    },
    async markUploaded() { events.push('uploaded'); current = { ...current, state: 'uploaded' }; return current; },
    async markVerified() { events.push('verified'); current = { ...current, state: 'verified' }; return current; },
    async recordFailure(_id, failure) { events.push(['failed', failure]); current = { ...current, state: 'failed' }; },
    async pruneVerifiedMonth() { events.push('pruned'); current = { ...current, state: 'pruned' }; return { heartRateSamples: 2, calorieIntervals: 1 }; },
    async list() { return [current]; },
    async getById() { return current; },
  };
}

function serviceFor(repository, overrides = {}) {
  const calls = [];
  return {
    calls,
    service: createHealthArchiveService({
      repository,
      config: {
        enabled: true,
        pruningEnabled: false,
        currentKeyVersion: 1,
        encryptionKeys: new Map([[1, Buffer.alloc(32, 1)]]),
      },
      now: () => new Date('2026-07-21T00:00:00Z'),
      async buildArchive() {
        calls.push('build');
        return {
          filePath: 'archive.hharchive',
          objectKey: `health-hub/raw/v1/2026/01/health-raw-2026-01-${hash}.hharchive`,
          ciphertextHash: hash,
          plaintextHash: 'b'.repeat(64),
          byteSize: 123,
          heartSampleCount: 2,
          calorieIntervalCount: 1,
          measurementStartedAt: '2026-01-02T12:00:00.000Z',
          measurementEndedAt: '2026-01-02T12:05:00.000Z',
          encryptionKeyVersion: 1,
          cleanup: async () => { calls.push('cleanup'); },
        };
      },
      objectStore: {
        async uploadCreateOnly() { calls.push('upload'); return { created: true }; },
      },
      async verifyStoredArchive() { calls.push('verify'); return { valid: true }; },
      ...overrides,
    }),
  };
}

test('already verified catalog entries are idempotent and do no network or build work', async () => {
  const repository = repositoryFor(catalog('verified'));
  const { service, calls } = serviceFor(repository);

  const result = await service.archiveMonth({ sourceAccountId, archiveMonth });

  assert.equal(result.idempotent, true);
  assert.equal(result.catalog.state, 'verified');
  assert.deepEqual(calls, []);
  assert.deepEqual(repository.events, ['reserve']);
});

test('an uploaded interruption resumes at complete readback verification without rebuilding', async () => {
  const repository = repositoryFor(catalog('uploaded'));
  const { service, calls } = serviceFor(repository);

  const result = await service.archiveMonth({ sourceAccountId, archiveMonth });

  assert.equal(result.catalog.state, 'verified');
  assert.deepEqual(calls, ['verify']);
  assert.deepEqual(repository.events, ['reserve', 'verified']);
});

test('new archive records content identity before create-only upload and verification', async () => {
  const repository = repositoryFor(catalog('pending'));
  const { service, calls } = serviceFor(repository);

  const result = await service.archiveMonth({ sourceAccountId, archiveMonth });

  assert.equal(result.catalog.state, 'verified');
  assert.deepEqual(calls, ['build', 'upload', 'verify', 'cleanup']);
  assert.deepEqual(repository.events, ['reserve', 'building', 'built', 'uploaded', 'verified']);
});

test('readback verification failure records safe metadata, retains rows, and blocks pruning', async () => {
  const repository = repositoryFor(catalog('pending'));
  let prunes = 0;
  const { service } = serviceFor(repository, {
    config: {
      enabled: true,
      pruningEnabled: true,
      currentKeyVersion: 1,
      encryptionKeys: new Map([[1, Buffer.alloc(32, 1)]]),
    },
    async verifyStoredArchive() { throw new Error('response contained secret-value'); },
    pruner: { async prune() { prunes += 1; } },
  });

  await assert.rejects(
    service.archiveMonth({ sourceAccountId, archiveMonth, prune: true }),
    /Health archive verify failed/,
  );
  assert.equal(prunes, 0);
  assert.equal(repository.current.state, 'failed');
  const failure = repository.events.find((event) => Array.isArray(event))[1];
  assert.equal(failure.errorCode, 'ARCHIVE_VERIFY_FAILED');
  assert.equal(failure.errorMessage, 'Health archive verify failed');
  assert.doesNotMatch(JSON.stringify(failure), /secret-value/);
});

test('actual pruning needs both explicit archive and pruning gates and runs only after verification', async () => {
  const disabledRepository = repositoryFor(catalog('verified'));
  const disabled = serviceFor(disabledRepository, {
    config: {
      enabled: false,
      pruningEnabled: true,
      currentKeyVersion: 1,
      encryptionKeys: new Map([[1, Buffer.alloc(32, 1)]]),
    },
  }).service;
  await assert.rejects(
    disabled.archiveMonth({ sourceAccountId, archiveMonth, prune: true }),
    /HEALTH_ARCHIVE_ENABLED=true/,
  );

  const enabledRepository = repositoryFor(catalog('pending'));
  const { service } = serviceFor(enabledRepository, {
    config: {
      enabled: true,
      pruningEnabled: true,
      currentKeyVersion: 1,
      encryptionKeys: new Map([[1, Buffer.alloc(32, 1)]]),
    },
  });
  const result = await service.archiveMonth({ sourceAccountId, archiveMonth, prune: true });
  assert.equal(result.catalog.state, 'pruned');
  assert.ok(enabledRepository.events.indexOf('pruned') > enabledRepository.events.indexOf('verified'));
});

test('dry run and ineligible months neither reserve a catalog row nor use object storage', async () => {
  const repository = repositoryFor(catalog('pending'));
  const { service, calls } = serviceFor(repository);
  assert.deepEqual(
    await service.archiveMonth({ sourceAccountId, archiveMonth, dryRun: true }),
    { dryRun: true, eligible: true, sourceAccountId, archiveMonth },
  );
  await assert.rejects(
    service.archiveMonth({ sourceAccountId, archiveMonth: '2026-06-01' }),
    /not yet eligible/,
  );
  assert.deepEqual(repository.events, []);
  assert.deepEqual(calls, []);
});

test('operator extraction refuses and preserves a pre-existing output directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'archive-existing-output-'));
  const outputDirectory = path.join(root, 'restore');
  const sentinelPath = path.join(outputDirectory, 'keep.txt');
  await mkdir(outputDirectory);
  await writeFile(sentinelPath, 'keep me');
  const repository = repositoryFor(catalog('verified'));
  let downloads = 0;
  const { service } = serviceFor(repository, {
    temporaryRoot: path.join(root, 'temp'),
    objectStore: { async downloadToFile() { downloads += 1; } },
  });

  try {
    await assert.rejects(
      service.extractById({ id: repository.current.id, outputDirectory }),
      /already exists/,
    );
    assert.equal(await readFile(sentinelPath, 'utf8'), 'keep me');
    assert.equal(downloads, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit readback verification records failure and blocks a previously verified catalog', async () => {
  const repository = repositoryFor(catalog('verified'));
  const { service } = serviceFor(repository, {
    async verifyStoredArchive() { throw new Error('tampered object'); },
  });

  await assert.rejects(service.verifyById(repository.current.id), /Health archive verify failed/);
  assert.equal(repository.current.state, 'failed');
  assert.deepEqual(repository.events.at(-1), ['failed', {
    errorCode: 'ARCHIVE_VERIFY_FAILED',
    errorMessage: 'Health archive verify failed',
  }]);
});

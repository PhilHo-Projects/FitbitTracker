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
    async reserveMonth(_sourceAccountId, _archiveMonth, { rebuild = false } = {}) {
      events.push(rebuild ? 'reserve-rebuild' : 'reserve');
      if (rebuild) {
        current = {
          ...current,
          id: '33333333-3333-3333-3333-333333333333',
          archive_version: Number(current.archive_version) + 1,
          state: 'pending',
          object_key: null,
          ciphertext_hash: null,
          plaintext_hash: null,
          byte_size: null,
          heart_sample_count: 0,
          calorie_interval_count: 0,
          encryption_key_version: null,
          error_code: null,
          error_message: null,
        };
      }
      return current;
    },
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
    async recordVerificationSuccess() {
      events.push('verification-succeeded');
      current = {
        ...current,
        state: current.state === 'failed' ? 'verified' : current.state,
        error_code: null,
        error_message: null,
      };
      return current;
    },
    async recordFailure(_id, failure) { events.push(['failed', failure]); current = { ...current, state: 'failed' }; },
    async recordVerificationFailure(_id, failure) {
      events.push(['verification-failed', failure]);
      if (current.state !== 'pruned') current = { ...current, state: 'failed' };
      return current;
    },
    async pruneVerifiedMonth(_id, options) {
      events.push(['pruned', options.archiveDirectory]);
      current = { ...current, state: 'pruned' };
      return { compactHeartRateSamples: 2, compactCalorieIntervals: 1 };
    },
    async list() { return { items: [current], nextCursor: null }; },
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
      async verifyStoredArchive(options) {
        calls.push('verify');
        if (options.withValidatedArchive) {
          return options.withValidatedArchive({ directory: 'verified-files', valid: true });
        }
        return { valid: true };
      },
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
  assert.deepEqual(enabledRepository.events, [
    'reserve', 'building', 'built', 'uploaded', 'verified', ['pruned', 'verified-files'],
  ]);
});

test('pruning an already verified month always performs a fresh scoped object verification', async () => {
  const repository = repositoryFor(catalog('verified'));
  const { service, calls } = serviceFor(repository, {
    config: {
      enabled: true,
      pruningEnabled: true,
      currentKeyVersion: 1,
      encryptionKeys: new Map([[1, Buffer.alloc(32, 1)]]),
    },
  });

  await service.archiveMonth({ sourceAccountId, archiveMonth, prune: true });

  assert.deepEqual(calls, ['verify']);
  assert.deepEqual(repository.events, ['reserve', ['pruned', 'verified-files']]);
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
  assert.deepEqual(repository.events.at(-1), ['verification-failed', {
    errorCode: 'ARCHIVE_VERIFY_FAILED',
    errorMessage: 'Health archive verify failed',
  }]);
});

test('explicit verification failure preserves a pruned catalog state and safe error', async () => {
  const repository = repositoryFor(catalog('pruned'));
  const { service } = serviceFor(repository, {
    async verifyStoredArchive() { throw new Error('tampered object'); },
  });

  await assert.rejects(service.verifyById(repository.current.id), (error) => {
    assert.equal(error.code, 'ARCHIVE_VERIFY_FAILED');
    assert.equal(error.message, 'Health archive verify failed');
    return true;
  });
  assert.equal(repository.current.state, 'pruned');
  assert.deepEqual(repository.events.at(-1), ['verification-failed', {
    errorCode: 'ARCHIVE_VERIFY_FAILED',
    errorMessage: 'Health archive verify failed',
  }]);
});

test('a repeated prune request freshly verifies and preserves a pruned state on failure', async () => {
  const repository = repositoryFor(catalog('pruned'));
  const { service } = serviceFor(repository, {
    config: {
      enabled: true,
      pruningEnabled: true,
      currentKeyVersion: 1,
      encryptionKeys: new Map([[1, Buffer.alloc(32, 1)]]),
    },
    async verifyStoredArchive() { throw new Error('tampered object'); },
  });

  await assert.rejects(
    service.archiveMonth({ sourceAccountId, archiveMonth, prune: true }),
    /Health archive verify failed/,
  );
  assert.equal(repository.current.state, 'pruned');
  assert.deepEqual(repository.events, ['reserve', ['verification-failed', {
    errorCode: 'ARCHIVE_VERIFY_FAILED',
    errorMessage: 'Health archive verify failed',
  }]]);
});

test('successful operator re-verification restores failed active state without reactivating terminal rows', async () => {
  for (const [initialState, expectedState] of [
    ['failed', 'verified'],
    ['superseded', 'superseded'],
    ['pruned', 'pruned'],
  ]) {
    const repository = repositoryFor(catalog(initialState, {
      error_code: 'ARCHIVE_VERIFY_FAILED',
      error_message: 'Health archive verify failed',
    }));
    const { service } = serviceFor(repository);

    const result = await service.verifyById(repository.current.id);

    assert.equal(result.catalog.state, expectedState);
    assert.equal(result.catalog.error_code, null);
    assert.equal(result.catalog.error_message, null);
    assert.deepEqual(repository.events, ['verification-succeeded']);
  }
});

test('explicit rebuild creates and verifies a new immutable version after prune mismatch', async () => {
  const repository = repositoryFor(catalog('verified', {
    error_code: 'ARCHIVE_PRUNE_FAILED',
    error_message: 'Health archive prune failed',
  }));
  const replacementHash = 'c'.repeat(64);
  const { service } = serviceFor(repository, {
    async buildArchive() {
      return {
        filePath: 'replacement.hharchive',
        objectKey: `health-hub/raw/v1/2026/01/health-raw-2026-01-${replacementHash}.hharchive`,
        ciphertextHash: replacementHash,
        plaintextHash: 'd'.repeat(64),
        byteSize: 456,
        heartSampleCount: 3,
        calorieIntervalCount: 1,
        measurementStartedAt: '2026-01-02T12:00:00.000123Z',
        measurementEndedAt: '2026-01-02T12:05:00.000456Z',
        encryptionKeyVersion: 1,
        cleanup: async () => {},
      };
    },
  });

  const result = await service.archiveMonth({
    sourceAccountId,
    archiveMonth,
    rebuild: true,
  });

  assert.equal(result.catalog.archive_version, 2);
  assert.equal(result.catalog.state, 'verified');
  assert.match(result.catalog.object_key, new RegExp(replacementHash));
  assert.deepEqual(repository.events, [
    'reserve-rebuild', 'building', 'built', 'uploaded', 'verified',
  ]);
});

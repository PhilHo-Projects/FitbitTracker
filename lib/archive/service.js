import { access, mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { buildMonthBundle, extractMonthBundle, validateExtractedMonth } from './bundle.js';
import { createArchiveEnvelope, decryptArchiveEnvelope } from './format.js';
import { importExtractedMonth } from './import.js';
import { objectKeyForArchive } from './s3.js';

function isoCivilDate(value) {
  if (typeof value === 'string') return value.slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
}

export function assertCatalogEnvelopeBinding(catalog, header) {
  if (
    header?.sourceAccountId !== catalog.source_account_id
    || header?.archiveMonth !== isoCivilDate(catalog.archive_month)
    || Number(header?.encryptionKeyVersion) !== Number(catalog.encryption_key_version)
  ) throw new Error('Archive authenticated metadata mismatch');
}

export function isArchiveMonthEligible(archiveMonth, now = new Date(), retentionDays = 90) {
  const normalized = isoCivilDate(archiveMonth);
  if (!/^\d{4}-\d{2}-01$/.test(normalized)) {
    throw new Error('Archive month must be the first civil date of a month');
  }
  const monthStart = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(monthStart.valueOf())) throw new Error('Archive month is invalid');
  const nextMonth = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
  const finalCivilDate = new Date(nextMonth.valueOf() - 24 * 60 * 60 * 1000);
  const today = new Date(`${isoCivilDate(now)}T00:00:00Z`);
  return today.valueOf() - finalCivilDate.valueOf() >= retentionDays * 24 * 60 * 60 * 1000;
}

async function createDefaultArchive({
  pool,
  config,
  temporaryRoot,
  batchSize,
  sourceAccountId,
  archiveMonth,
}) {
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(temporaryRoot, 'health-archive-build-'));
  const filesDirectory = path.join(directory, 'files');
  const bundlePath = path.join(directory, 'month.bundle.gz');
  const archivePath = path.join(directory, 'month.hharchive');
  try {
    const bundle = await buildMonthBundle({
      pool,
      sourceAccountId,
      archiveMonth,
      directory: filesDirectory,
      outputPath: bundlePath,
      batchSize,
    });
    const envelope = await createArchiveEnvelope({
      inputPath: bundlePath,
      outputPath: archivePath,
      encryptionKeys: config.encryptionKeys,
      keyVersion: config.currentKeyVersion,
      sourceAccountId,
      archiveMonth,
    });
    return {
      filePath: archivePath,
      objectKey: objectKeyForArchive(archiveMonth, envelope.ciphertextHash),
      ciphertextHash: envelope.ciphertextHash,
      plaintextHash: envelope.plaintextHash,
      byteSize: envelope.byteSize,
      heartSampleCount: bundle.heartSampleCount,
      calorieIntervalCount: bundle.calorieIntervalCount,
      measurementStartedAt: bundle.measurementStartedAt,
      measurementEndedAt: bundle.measurementEndedAt,
      encryptionKeyVersion: config.currentKeyVersion,
      temporaryDirectory: directory,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function verifyDefaultStoredArchive({
  objectStore,
  config,
  temporaryRoot,
  catalog,
  withValidatedArchive,
}) {
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(temporaryRoot, 'health-archive-verify-'));
  const archivePath = path.join(directory, 'readback.hharchive');
  const bundlePath = path.join(directory, 'readback.bundle.gz');
  const extractedDirectory = path.join(directory, 'extracted');
  try {
    const downloaded = await objectStore.downloadToFile({
      key: catalog.object_key,
      outputPath: archivePath,
    });
    if (
      downloaded.ciphertextHash !== catalog.ciphertext_hash
      || Number(downloaded.byteSize) !== Number(catalog.byte_size)
    ) throw new Error('Archive ciphertext readback mismatch');
    const decrypted = await decryptArchiveEnvelope({
      inputPath: archivePath,
      outputPath: bundlePath,
      encryptionKeys: config.encryptionKeys,
    });
    if (decrypted.plaintextHash !== catalog.plaintext_hash) {
      throw new Error('Archive plaintext hash mismatch');
    }
    assertCatalogEnvelopeBinding(catalog, decrypted.header);
    const validated = await extractMonthBundle({
      inputPath: bundlePath,
      outputDirectory: extractedDirectory,
    }).then(() => validateExtractedMonth({
      directory: extractedDirectory,
      expectedSourceAccountId: catalog.source_account_id,
      expectedArchiveMonth: isoCivilDate(catalog.archive_month),
      expectedHeartSampleCount: catalog.heart_sample_count,
      expectedCalorieIntervalCount: catalog.calorie_interval_count,
    }));
    const result = { valid: true, ...validated };
    if (withValidatedArchive) {
      result.scopedResult = await withValidatedArchive({
        directory: extractedDirectory,
        catalog,
        ...result,
      });
    }
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

function failureForStage(stage) {
  const safeStage = ['build', 'upload', 'verify', 'prune'].includes(stage) ? stage : 'operation';
  return {
    errorCode: `ARCHIVE_${safeStage.toUpperCase()}_FAILED`,
    errorMessage: `Health archive ${safeStage} failed`,
  };
}

async function requireNewExtractionDirectory(outputDirectory) {
  try {
    await access(outputDirectory);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Archive extraction output directory already exists');
}

export function createHealthArchiveService({
  pool,
  repository,
  objectStore,
  config,
  temporaryRoot = path.resolve('.runtime', 'health-archive'),
  batchSize = 1000,
  now = () => new Date(),
  buildArchive,
  verifyStoredArchive,
} = {}) {
  if (!repository) throw new Error('Health archive service requires a catalog repository');
  const build = buildArchive ?? ((options) => createDefaultArchive({
    pool, config, temporaryRoot, batchSize, ...options,
  }));
  const verify = verifyStoredArchive ?? ((options) => verifyDefaultStoredArchive({
    objectStore, config, temporaryRoot, ...options,
  }));

  async function archiveMonth({ sourceAccountId, archiveMonth, dryRun = false, prune = false }) {
    if (!isArchiveMonthEligible(archiveMonth, now())) {
      throw new Error(`Archive month ${archiveMonth} is not yet eligible`);
    }
    if (prune && !config.enabled) {
      throw new Error('Pruning requires HEALTH_ARCHIVE_ENABLED=true');
    }
    if (prune && !config.pruningEnabled) {
      throw new Error('Pruning requires HEALTH_RAW_PRUNING_ENABLED=true');
    }
    if (dryRun) return { dryRun: true, eligible: true, sourceAccountId, archiveMonth };

    return repository.withMonthLock(sourceAccountId, archiveMonth, async (lockedRepository) => {
      let catalog = await lockedRepository.reserveMonth(sourceAccountId, archiveMonth);
      if (catalog.state === 'pruned' && !prune) return { catalog, idempotent: true };
      if (catalog.state === 'verified' && !prune) return { catalog, idempotent: true };

      let stage = 'verify';
      let built;
      try {
        if (catalog.state === 'pending' || (catalog.state === 'building' && !catalog.object_key)) {
          stage = 'build';
          catalog = await lockedRepository.markBuilding(catalog.id);
          built = await build({ sourceAccountId, archiveMonth, catalog });
          catalog = await lockedRepository.recordBuilt(catalog.id, built);
          stage = 'upload';
          await objectStore.uploadCreateOnly({
            key: built.objectKey,
            filePath: built.filePath,
            expectedHash: built.ciphertextHash,
            temporaryDirectory: built.temporaryDirectory,
          });
          catalog = await lockedRepository.markUploaded(catalog.id);
        }
        if (!prune && !['verified', 'pruning', 'pruned'].includes(catalog.state)) {
          stage = 'verify';
          await verify({ catalog });
          catalog = await lockedRepository.markVerified(catalog.id);
        }
        if (prune) {
          stage = 'verify';
          let removed;
          let validatedScopeUsed = false;
          await verify({
            catalog,
            async withValidatedArchive({ directory }) {
              validatedScopeUsed = true;
              if (catalog.state === 'pruned') return;
              if (!['verified', 'pruning'].includes(catalog.state)) {
                catalog = await lockedRepository.markVerified(catalog.id);
              }
              stage = 'prune';
              removed = await lockedRepository.pruneVerifiedMonth(catalog.id, {
                batchSize,
                archiveDirectory: directory,
              });
              catalog = { ...catalog, state: 'pruned' };
            },
          });
          if (!validatedScopeUsed) {
            throw new Error('Archive verification did not provide a validated extraction scope');
          }
          return { catalog, idempotent: catalog.state === 'pruned' && removed === undefined, removed };
        }
        return { catalog, idempotent: false };
      } catch (error) {
        if (stage === 'verify') {
          await lockedRepository.recordVerificationFailure(catalog.id, failureForStage(stage));
        } else if (stage !== 'prune') {
          await lockedRepository.recordFailure(catalog.id, failureForStage(stage));
        }
        const safe = failureForStage(stage);
        const wrapped = new Error(safe.errorMessage, { cause: error });
        wrapped.code = safe.errorCode;
        throw wrapped;
      } finally {
        await built?.cleanup?.().catch(() => {});
      }
    });
  }

  return {
    archiveMonth,
    list: (filters) => repository.list(filters),
    verifyCatalog: async (catalog) => verify({ catalog }),

    async verifyById(id) {
      const initial = await repository.getById(id);
      return repository.withMonthLock(
        initial.source_account_id,
        isoCivilDate(initial.archive_month),
        async (lockedRepository) => {
          let catalog = await lockedRepository.getById(id);
          try {
            await verify({ catalog });
          } catch (cause) {
            const failure = failureForStage('verify');
            await lockedRepository.recordVerificationFailure(id, failure);
            const error = new Error(failure.errorMessage, { cause });
            error.code = failure.errorCode;
            throw error;
          }
          if (!['verified', 'pruning', 'pruned'].includes(catalog.state)) {
            catalog = await lockedRepository.markVerified(id);
          }
          return { catalog, valid: true };
        },
      );
    },

    async extractById({ id, outputDirectory }) {
      if (!outputDirectory) throw new Error('Archive extraction requires an explicit output directory');
      await requireNewExtractionDirectory(outputDirectory);
      const catalog = await repository.getById(id);
      if (!['verified', 'pruned'].includes(catalog.state)) {
        throw new Error('Only a verified archive can be extracted');
      }
      await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
      const directory = await mkdtemp(path.join(temporaryRoot, 'health-archive-extract-'));
      const archivePath = path.join(directory, 'readback.hharchive');
      const bundlePath = path.join(directory, 'readback.bundle.gz');
      let extracted = false;
      try {
        const downloaded = await objectStore.downloadToFile({
          key: catalog.object_key,
          outputPath: archivePath,
        });
        if (
          downloaded.ciphertextHash !== catalog.ciphertext_hash
          || Number(downloaded.byteSize) !== Number(catalog.byte_size)
        ) throw new Error('Archive ciphertext readback mismatch');
        const decrypted = await decryptArchiveEnvelope({
          inputPath: archivePath,
          outputPath: bundlePath,
          encryptionKeys: config.encryptionKeys,
        });
        if (decrypted.plaintextHash !== catalog.plaintext_hash) {
          throw new Error('Archive plaintext hash mismatch');
        }
        assertCatalogEnvelopeBinding(catalog, decrypted.header);
        await extractMonthBundle({ inputPath: bundlePath, outputDirectory });
        extracted = true;
        const validated = await validateExtractedMonth({
          directory: outputDirectory,
          expectedSourceAccountId: catalog.source_account_id,
          expectedArchiveMonth: isoCivilDate(catalog.archive_month),
          expectedHeartSampleCount: catalog.heart_sample_count,
          expectedCalorieIntervalCount: catalog.calorie_interval_count,
        });
        return { catalog, outputDirectory, ...validated };
      } catch (error) {
        if (extracted) await rm(outputDirectory, { recursive: true, force: true }).catch(() => {});
        throw error;
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    },

    async importById({ id, targetPool, importBatchSize = batchSize }) {
      const catalog = await repository.getById(id);
      if (!['verified', 'pruned'].includes(catalog.state)) {
        throw new Error('Only a verified archive can be imported');
      }
      await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
      const directory = await mkdtemp(path.join(temporaryRoot, 'health-archive-import-'));
      const archivePath = path.join(directory, 'readback.hharchive');
      const bundlePath = path.join(directory, 'readback.bundle.gz');
      const extractedDirectory = path.join(directory, 'extracted');
      try {
        const downloaded = await objectStore.downloadToFile({ key: catalog.object_key, outputPath: archivePath });
        if (
          downloaded.ciphertextHash !== catalog.ciphertext_hash
          || Number(downloaded.byteSize) !== Number(catalog.byte_size)
        ) throw new Error('Archive ciphertext readback mismatch');
        const decrypted = await decryptArchiveEnvelope({
          inputPath: archivePath,
          outputPath: bundlePath,
          encryptionKeys: config.encryptionKeys,
        });
        if (decrypted.plaintextHash !== catalog.plaintext_hash) {
          throw new Error('Archive plaintext hash mismatch');
        }
        assertCatalogEnvelopeBinding(catalog, decrypted.header);
        await extractMonthBundle({ inputPath: bundlePath, outputDirectory: extractedDirectory });
        await validateExtractedMonth({
          directory: extractedDirectory,
          expectedSourceAccountId: catalog.source_account_id,
          expectedArchiveMonth: isoCivilDate(catalog.archive_month),
          expectedHeartSampleCount: catalog.heart_sample_count,
          expectedCalorieIntervalCount: catalog.calorie_interval_count,
        });
        return importExtractedMonth({
          directory: extractedDirectory,
          targetPool,
          batchSize: importBatchSize,
        });
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

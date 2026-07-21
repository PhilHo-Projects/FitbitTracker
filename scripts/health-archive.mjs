import path from 'node:path';
import process from 'node:process';

import pg from 'pg';

import { parseArchiveConfig } from '../lib/archive/config.js';
import { assertSafeImportTarget } from '../lib/archive/import.js';
import { parseHealthArchiveArgs } from '../lib/archive/operator.js';
import { createHealthArchiveRepository } from '../lib/archive/repository.js';
import { createArchiveObjectStore, createS3ClientFromConfig } from '../lib/archive/s3.js';
import { createHealthArchiveService } from '../lib/archive/service.js';
import { createPool } from '../lib/db/pool.js';

const { Pool } = pg;

let pool;
let targetPool;
let s3Client;

try {
  const options = parseHealthArchiveArgs(process.argv.slice(2));
  pool = createPool();
  if (!pool) throw new Error('DATABASE_URL is required for health archive operations');
  const needsNetwork = ['verify', 'extract', 'import'].includes(options.command)
    || (options.command === 'run' && options.execute);
  const config = parseArchiveConfig(process.env, { required: needsNetwork });
  const repository = createHealthArchiveRepository(pool);
  let objectStore;
  if (needsNetwork) {
    s3Client = createS3ClientFromConfig(config);
    objectStore = createArchiveObjectStore({ client: s3Client, bucket: config.bucket });
  }
  const service = createHealthArchiveService({
    pool,
    repository,
    objectStore,
    config,
    batchSize: Number(process.env.HEALTH_ARCHIVE_BATCH_SIZE || 1000),
    temporaryRoot: process.env.HEALTH_ARCHIVE_TEMP_DIR
      ? path.resolve(process.env.HEALTH_ARCHIVE_TEMP_DIR)
      : path.resolve('.runtime', 'health-archive'),
  });

  let result;
  if (options.command === 'list') {
    result = await service.list({
      sourceAccountId: options.sourceAccountId,
      archiveMonth: options.archiveMonth,
      state: options.state,
      limit: options.limit,
      cursor: options.cursor,
    });
  } else if (options.command === 'verify') {
    result = await service.verifyById(options.id);
  } else if (options.command === 'extract') {
    result = await service.extractById({
      id: options.id,
      outputDirectory: path.resolve(options.outputDirectory),
    });
  } else if (options.command === 'import') {
    assertSafeImportTarget({
      targetDatabaseUrl: options.targetDatabaseUrl,
      currentDatabaseUrl: process.env.DATABASE_URL,
      allowProductionTarget: options.allowProductionTarget,
    });
    targetPool = new Pool({
      connectionString: options.targetDatabaseUrl,
      ssl: process.env.HEALTH_ARCHIVE_IMPORT_DATABASE_SSL === 'true'
        ? { rejectUnauthorized: false }
        : undefined,
      application_name: 'personal-health-data-hub-archive-import',
    });
    result = await service.importById({
      id: options.id,
      targetPool,
      importBatchSize: options.batchSize,
    });
  } else {
    result = await service.archiveMonth({
      sourceAccountId: options.sourceAccountId,
      archiveMonth: options.archiveMonth,
      dryRun: !options.execute,
      prune: options.prune,
    });
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`${error.code || 'HEALTH_ARCHIVE_COMMAND_FAILED'}: ${error.message}`);
  process.exitCode = 1;
} finally {
  await targetPool?.end().catch(() => {});
  s3Client?.destroy();
  await pool?.end().catch(() => {});
}

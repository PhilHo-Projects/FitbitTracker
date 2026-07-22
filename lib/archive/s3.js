import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export function objectKeyForArchive(archiveMonth, ciphertextHash) {
  if (!/^\d{4}-\d{2}-01$/.test(archiveMonth)) {
    throw new Error('Archive month must be the first civil date of a month');
  }
  if (!/^[a-f0-9]{64}$/.test(ciphertextHash)) {
    throw new Error('Archive content identity must be a full lowercase SHA-256');
  }
  const yearMonth = archiveMonth.slice(0, 7);
  const [year, month] = yearMonth.split('-');
  return `health-hub/raw/v1/${year}/${month}/health-raw-${yearMonth}-${ciphertextHash}.hharchive`;
}

export function createS3ClientFromConfig({ endpoint, region, accessKeyId, secretAccessKey }) {
  return new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function responseBodyAsReadable(body) {
  if (!body) throw new Error('Archive object download returned no body');
  if (typeof body.pipe === 'function' || body[Symbol.asyncIterator]) return body;
  if (typeof body.transformToWebStream === 'function') {
    return Readable.fromWeb(body.transformToWebStream());
  }
  throw new Error('Archive object download returned an unsupported body');
}

async function writeAll(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset);
    offset += bytesWritten;
  }
}

async function hashFile(filePath) {
  const hasher = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hasher.update(chunk);
  return hasher.digest('hex');
}

function isPreconditionFailure(error) {
  return error?.name === 'PreconditionFailed' || error?.$metadata?.httpStatusCode === 412;
}

export function createArchiveObjectStore({ client, bucket }) {
  if (!client || !bucket) throw new Error('Archive object store requires a client and bucket');

  async function downloadToFile({ key, outputPath }) {
    let output;
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      output = await open(outputPath, 'wx', 0o600);
      const hasher = crypto.createHash('sha256');
      let byteSize = 0;
      for await (const value of responseBodyAsReadable(response.Body)) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        hasher.update(chunk);
        byteSize += chunk.length;
        await writeAll(output, chunk);
      }
      await output.sync();
      await output.close();
      output = null;
      return { ciphertextHash: hasher.digest('hex'), byteSize };
    } catch (error) {
      await output?.close().catch(() => {});
      await rm(outputPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  return {
    downloadToFile,

    async uploadCreateOnly({ key, filePath, expectedHash, temporaryDirectory }) {
      if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('Expected ciphertext hash is invalid');
      if (!key.endsWith(`-${expectedHash}.hharchive`)) {
        throw new Error('Archive object key does not match its ciphertext hash');
      }
      const localHash = await hashFile(filePath);
      if (localHash !== expectedHash) throw new Error('Local archive ciphertext hash mismatch');
      const details = await stat(filePath);
      try {
        await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: createReadStream(filePath),
          ContentLength: details.size,
          ContentType: 'application/octet-stream',
          IfNoneMatch: '*',
          Metadata: { sha256: expectedHash, format: 'hharchive-v1' },
        }));
        return { created: true, idempotent: false, ciphertextHash: expectedHash };
      } catch (error) {
        if (!isPreconditionFailure(error)) throw error;
      }

      if (!temporaryDirectory) {
        throw new Error('A temporary directory is required to verify an existing archive object');
      }
      const readbackPath = path.join(temporaryDirectory, `existing-${crypto.randomUUID()}.hharchive`);
      try {
        const readback = await downloadToFile({ key, outputPath: readbackPath });
        if (readback.ciphertextHash !== expectedHash || readback.byteSize !== details.size) {
          throw new Error('existing archive object hash mismatch after full readback');
        }
        return { created: false, idempotent: true, ciphertextHash: expectedHash };
      } finally {
        await rm(readbackPath, { force: true }).catch(() => {});
      }
    },
  };
}

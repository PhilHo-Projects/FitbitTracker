import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, open, rename, rm, stat } from 'node:fs/promises';
import { once } from 'node:events';

const MAGIC = Buffer.from('HHARCHV1', 'ascii');
const AUTH_TAG_BYTES = 16;
const FIXED_HEADER_BYTES = MAGIC.length + 4;
const MAX_HEADER_BYTES = 16 * 1024;

// HHARCHV1 envelope (all header bytes are AES-GCM AAD):
//   8-byte magic | 4-byte BE JSON-header length | UTF-8 JSON header
//   | AES-256-GCM ciphertext of the deterministic gzip bundle | 16-byte auth tag
// The catalog plaintext hash covers the complete gzip bundle. The ciphertext hash and immutable
// object key cover every stored envelope byte, including the authenticated header and auth tag.

async function writeChunk(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset);
    offset += bytesWritten;
  }
}

async function outputDoesNotExist(outputPath) {
  try {
    await access(outputPath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Refusing to overwrite existing archive output: ${outputPath}`);
}

function encodeHeader({ keyVersion, sourceAccountId, archiveMonth, nonce }) {
  const header = {
    format: 'health-hub-raw-archive',
    envelopeVersion: 1,
    bundleVersion: 1,
    cipher: 'AES-256-GCM',
    compression: 'gzip',
    encryptionKeyVersion: keyVersion,
    sourceAccountId,
    archiveMonth,
    nonce: nonce.toString('base64'),
  };
  return { header, bytes: Buffer.from(JSON.stringify(header), 'utf8') };
}

function authenticatedPrefix(headerBytes) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBytes.length);
  return Buffer.concat([MAGIC, length, headerBytes]);
}

async function readEnvelopeHeader(inputPath) {
  const handle = await open(inputPath, 'r');
  try {
    const fixed = Buffer.alloc(FIXED_HEADER_BYTES);
    const fixedRead = await handle.read(fixed, 0, fixed.length, 0);
    if (fixedRead.bytesRead !== fixed.length || !fixed.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('Unsupported health archive magic');
    }
    const headerLength = fixed.readUInt32BE(MAGIC.length);
    if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) {
      throw new Error('Invalid health archive header length');
    }
    const headerBytes = Buffer.alloc(headerLength);
    const headerRead = await handle.read(headerBytes, 0, headerLength, FIXED_HEADER_BYTES);
    if (headerRead.bytesRead !== headerLength) throw new Error('Truncated health archive header');
    let header;
    try {
      header = JSON.parse(headerBytes.toString('utf8'));
    } catch {
      throw new Error('Invalid health archive header JSON');
    }
    if (
      header.format !== 'health-hub-raw-archive'
      || header.envelopeVersion !== 1
      || header.bundleVersion !== 1
      || header.cipher !== 'AES-256-GCM'
      || header.compression !== 'gzip'
      || !Number.isInteger(header.encryptionKeyVersion)
    ) {
      throw new Error('Unsupported health archive header metadata');
    }
    const nonce = Buffer.from(String(header.nonce || ''), 'base64');
    if (nonce.length !== 12) throw new Error('Invalid health archive nonce');
    return {
      header,
      nonce,
      prefix: Buffer.concat([fixed, headerBytes]),
      payloadOffset: FIXED_HEADER_BYTES + headerLength,
    };
  } finally {
    await handle.close();
  }
}

export async function inspectArchiveEnvelope(inputPath) {
  const parsed = await readEnvelopeHeader(inputPath);
  const details = await stat(inputPath);
  if (details.size < parsed.payloadOffset + AUTH_TAG_BYTES) {
    throw new Error('Truncated health archive payload');
  }
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(inputPath)) hash.update(chunk);
  return {
    header: parsed.header,
    ciphertextHash: hash.digest('hex'),
    byteSize: details.size,
  };
}

export async function createArchiveEnvelope({
  inputPath,
  outputPath,
  encryptionKeys,
  keyVersion,
  sourceAccountId,
  archiveMonth,
  nonce = crypto.randomBytes(12),
}) {
  const key = encryptionKeys.get(keyVersion);
  if (!key) throw new Error(`Health archive encryption key version ${keyVersion} is unavailable`);
  if (key.length !== 32) throw new Error('Health archive encryption keys must contain exactly 32 bytes');
  if (nonce.length !== 12) throw new Error('Health archive nonce must contain exactly 12 bytes');
  await outputDoesNotExist(outputPath);

  const { header, bytes: headerBytes } = encodeHeader({
    keyVersion,
    sourceAccountId,
    archiveMonth,
    nonce,
  });
  const prefix = authenticatedPrefix(headerBytes);
  const plaintextHasher = crypto.createHash('sha256');
  const ciphertextHasher = crypto.createHash('sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(prefix);
  let handle;
  try {
    handle = await open(outputPath, 'wx', 0o600);
    await writeChunk(handle, prefix);
    ciphertextHasher.update(prefix);
    for await (const chunk of createReadStream(inputPath)) {
      plaintextHasher.update(chunk);
      const encrypted = cipher.update(chunk);
      await writeChunk(handle, encrypted);
      ciphertextHasher.update(encrypted);
    }
    const final = cipher.final();
    if (final.length) {
      await writeChunk(handle, final);
      ciphertextHasher.update(final);
    }
    const authTag = cipher.getAuthTag();
    await writeChunk(handle, authTag);
    ciphertextHasher.update(authTag);
    await handle.sync();
    await handle.close();
    handle = null;
    const details = await stat(outputPath);
    return {
      header,
      plaintextHash: plaintextHasher.digest('hex'),
      ciphertextHash: ciphertextHasher.digest('hex'),
      byteSize: details.size,
    };
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(outputPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function decryptArchiveEnvelope({
  inputPath,
  outputPath,
  encryptionKeys,
}) {
  await outputDoesNotExist(outputPath);
  const parsed = await readEnvelopeHeader(inputPath);
  const key = encryptionKeys.get(parsed.header.encryptionKeyVersion);
  if (!key) {
    throw new Error(
      `Health archive encryption key version ${parsed.header.encryptionKeyVersion} is unavailable`,
    );
  }
  const details = await stat(inputPath);
  const authTagOffset = details.size - AUTH_TAG_BYTES;
  if (authTagOffset < parsed.payloadOffset) throw new Error('Truncated health archive payload');
  const inputHandle = await open(inputPath, 'r');
  const authTag = Buffer.alloc(AUTH_TAG_BYTES);
  await inputHandle.read(authTag, 0, AUTH_TAG_BYTES, authTagOffset);
  await inputHandle.close();

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, parsed.nonce);
  decipher.setAAD(parsed.prefix);
  decipher.setAuthTag(authTag);
  const plaintextHasher = crypto.createHash('sha256');
  const partialPath = `${outputPath}.partial-${crypto.randomUUID()}`;
  let output;
  try {
    output = await open(partialPath, 'wx', 0o600);
    if (authTagOffset > parsed.payloadOffset) {
      const encryptedStream = createReadStream(inputPath, {
        start: parsed.payloadOffset,
        end: authTagOffset - 1,
      });
      for await (const chunk of encryptedStream) {
        const plaintext = decipher.update(chunk);
        plaintextHasher.update(plaintext);
        await writeChunk(output, plaintext);
      }
    }
    const final = decipher.final();
    plaintextHasher.update(final);
    await writeChunk(output, final);
    await output.sync();
    await output.close();
    output = null;
    await rename(partialPath, outputPath);
    const inspected = await inspectArchiveEnvelope(inputPath);
    return {
      ...inspected,
      plaintextHash: plaintextHasher.digest('hex'),
    };
  } catch (error) {
    await output?.close().catch(() => {});
    await rm(partialPath, { force: true }).catch(() => {});
    if (/authentic|Unsupported state|unable to authenticate/i.test(error.message)) {
      throw new Error('Health archive authentication failed');
    }
    throw error;
  }
}

export const HEALTH_ARCHIVE_FORMAT = Object.freeze({
  magic: MAGIC.toString('ascii'),
  envelopeVersion: 1,
  bundleVersion: 1,
  authTagBytes: AUTH_TAG_BYTES,
});

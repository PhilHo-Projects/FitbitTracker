import crypto from 'node:crypto';

function parseKeyring(serialized) {
  const keys = new Map();
  for (const entry of String(serialized || '').split(',')) {
    const [versionText, encoded] = entry.trim().split(':', 2);
    if (!versionText || !encoded) continue;
    const version = Number(versionText);
    const key = Buffer.from(encoded, 'base64');
    if (!Number.isInteger(version) || version < 1 || key.length !== 32) {
      throw new Error('Each journal encryption key must be version:base64 with exactly 32 bytes');
    }
    keys.set(version, key);
  }
  if (!keys.size) {
    throw new Error('JOURNAL_ENCRYPTION_KEYS must contain at least one AES-256 key');
  }
  return keys;
}

function databaseBuffer(value) {
  if (typeof value === 'string') return Buffer.from(value, 'base64');
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const text = buffer.toString('ascii');
  if (
    buffer.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(text)
  ) {
    const decoded = Buffer.from(text, 'base64');
    if (decoded.length < buffer.length) return decoded;
  }
  return buffer;
}

export function createJournalCipher(serializedKeyring) {
  const keys = parseKeyring(serializedKeyring);
  const currentVersion = Math.max(...keys.keys());

  return {
    encrypt(plaintext) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', keys.get(currentVersion), nonce);
      cipher.setAAD(Buffer.from(`journal:v${currentVersion}`));
      const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
      return {
        ciphertext,
        nonce,
        authTag: cipher.getAuthTag(),
        keyVersion: currentVersion,
      };
    },

    decrypt({ ciphertext, nonce, authTag, keyVersion }) {
      const version = Number(keyVersion);
      const key = keys.get(version);
      if (!key) throw new Error(`Journal encryption key version ${version} is unavailable`);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, databaseBuffer(nonce));
      decipher.setAAD(Buffer.from(`journal:v${version}`));
      decipher.setAuthTag(databaseBuffer(authTag));
      return Buffer.concat([
        decipher.update(databaseBuffer(ciphertext)),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}

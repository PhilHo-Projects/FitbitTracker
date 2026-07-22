function parseEncryptionKeys(serialized) {
  const keys = new Map();
  for (const rawEntry of String(serialized || '').split(',')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const separator = entry.indexOf(':');
    const versionText = separator < 0 ? '' : entry.slice(0, separator);
    const encoded = separator < 0 ? '' : entry.slice(separator + 1);
    const version = Number(versionText);
    const key = Buffer.from(encoded, 'base64');
    if (!Number.isInteger(version) || version < 1 || !encoded || key.length !== 32) {
      throw new Error(
        'Each health archive encryption key must be version:base64 with exactly 32 bytes',
      );
    }
    if (keys.has(version)) throw new Error(`Duplicate health archive encryption key version ${version}`);
    keys.set(version, key);
  }
  if (!keys.size) {
    throw new Error('HEALTH_ARCHIVE_ENCRYPTION_KEYS must contain at least one AES-256 key');
  }
  return keys;
}
function requireValue(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for health archive operations`);
  return value;
}

export function parseArchiveConfig(env = process.env, { required = false } = {}) {
  const enabled = env.HEALTH_ARCHIVE_ENABLED === 'true';
  const pruningEnabled = env.HEALTH_RAW_PRUNING_ENABLED === 'true';
  const region = env.HEALTH_ARCHIVE_S3_REGION?.trim() || 'auto';
  if (!enabled && !required) return { enabled, pruningEnabled, region };

  const endpoint = requireValue(env, 'HEALTH_ARCHIVE_S3_ENDPOINT');
  const bucket = requireValue(env, 'HEALTH_ARCHIVE_S3_BUCKET');
  const accessKeyId = requireValue(env, 'HEALTH_ARCHIVE_S3_ACCESS_KEY_ID');
  const secretAccessKey = requireValue(env, 'HEALTH_ARCHIVE_S3_SECRET_ACCESS_KEY');
  const encryptionKeys = parseEncryptionKeys(
    requireValue(env, 'HEALTH_ARCHIVE_ENCRYPTION_KEYS'),
  );

  let endpointUrl;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new Error('HEALTH_ARCHIVE_S3_ENDPOINT must be an absolute HTTPS URL');
  }
  if (endpointUrl.protocol !== 'https:') {
    throw new Error('HEALTH_ARCHIVE_S3_ENDPOINT must be an absolute HTTPS URL');
  }

  return {
    enabled,
    pruningEnabled,
    endpoint: endpointUrl.toString().replace(/\/$/, ''),
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    encryptionKeys,
    currentKeyVersion: Math.max(...encryptionKeys.keys()),
  };
}

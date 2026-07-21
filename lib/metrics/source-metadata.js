import crypto from 'node:crypto';

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

export function canonicalizeSourceMetadata(metadata) {
  return canonicalValue(metadata ?? {});
}

export function hashSourceMetadata(metadata) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalizeSourceMetadata(metadata)))
    .digest('hex');
}

export function sourceMetadataForRecord(record, dataType) {
  const dataSource = record.sourceFields?.dataSource;
  if (dataSource && typeof dataSource === 'object') {
    return canonicalizeSourceMetadata({ dataType, dataSource });
  }
  const device = record.device;
  return canonicalizeSourceMetadata({
    dataType,
    ...(device && typeof device === 'object' && Object.keys(device).length ? { device } : {}),
  });
}

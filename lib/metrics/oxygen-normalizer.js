import { canonicalizeSourceMetadata, hashSourceMetadata } from './source-metadata.js';
import { oxygenCivilDate, oxygenContractError, parseOxygenTime } from './oxygen-time.js';

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function points(payload) {
  if (!object(payload) || Object.hasOwn(payload, 'error')
    || (Object.hasOwn(payload, 'dataPoints') && !Array.isArray(payload.dataPoints))
    || (Object.hasOwn(payload, 'nextPageToken') && typeof payload.nextPageToken !== 'string')
    || (Object.keys(payload).length && !Object.hasOwn(payload, 'dataPoints') && !Object.hasOwn(payload, 'nextPageToken'))) {
    throw oxygenContractError();
  }
  return payload.dataPoints ?? [];
}

function percentage(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw oxygenContractError();
  return value;
}

function optionalPercentage(value) {
  return value == null ? null : percentage(value);
}

function normalize(payload, metric, transform) {
  const records = new Map();
  const originals = new Map();
  for (const point of points(payload)) {
    if (!object(point) || typeof point.name !== 'string' || !point.name.trim()
      || !object(point[metric]) || (point.dataSource != null && !object(point.dataSource))) throw oxygenContractError();
    const canonical = JSON.stringify(canonicalizeSourceMetadata(point));
    if (originals.has(point.name)) {
      if (originals.get(point.name) !== canonical) throw oxygenContractError();
      continue;
    }
    originals.set(point.name, canonical);
    records.set(point.name, {
      providerKey: point.name, providerId: point.name,
      sourceKey: hashSourceMetadata(point.dataSource ?? {}),
      sourceMetadata: point.dataSource ?? {}, sourceFields: point,
      ...transform(point[metric]),
    });
  }
  return [...records.values()];
}

export function normalizeOxygenSaturationSamples(payload) {
  return normalize(payload, 'oxygenSaturation', value => {
    const { epochNanoseconds, ...time } = parseOxygenTime(value.sampleTime);
    return { ...time, percentage: percentage(value.percentage) };
  });
}

export function normalizeDailyOxygenSaturation(payload) {
  return normalize(payload, 'dailyOxygenSaturation', value => {
    const averagePercentage = percentage(value.averagePercentage);
    const lowerBoundPercentage = optionalPercentage(value.lowerBoundPercentage);
    const upperBoundPercentage = optionalPercentage(value.upperBoundPercentage);
    if (lowerBoundPercentage !== null && upperBoundPercentage !== null
      && lowerBoundPercentage > upperBoundPercentage) throw oxygenContractError();
    const sd = value.standardDeviationPercentage ?? null;
    if (sd !== null && (typeof sd !== 'number' || !Number.isFinite(sd) || sd < 0)) throw oxygenContractError();
    return { civilDate: oxygenCivilDate(value.date), averagePercentage, lowerBoundPercentage,
      upperBoundPercentage, standardDeviationPercentage: sd,
      qualityFlags: [...(lowerBoundPercentage === null || upperBoundPercentage === null ? ['bounds-missing'] : []),
        ...(averagePercentage === 0 ? ['provider-zero'] : [])],
    };
  });
}

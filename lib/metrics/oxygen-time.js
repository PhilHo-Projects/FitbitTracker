const SECOND = 1_000_000_000n;
const DAY = 86_400n * SECOND;

export function oxygenContractError() {
  return Object.assign(new Error('Google Health returned an invalid oxygen record'), {
    code: 'OXYGEN_CONTRACT_INVALID', transient: false,
  });
}

export function oxygenCivilDate(value) {
  const date = typeof value === 'string' ? value : value &&
    [value.year, value.month, value.day].every(Number.isInteger)
    ? `${String(value.year).padStart(4, '0')}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`
    : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000')) throw oxygenContractError();
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw oxygenContractError();
  return date;
}

export function floorDivide(value, divisor) {
  const result = value / divisor;
  return value < 0n && value % divisor !== 0n ? result - 1n : result;
}

export function oxygenInstantNanoseconds(timestamp) {
  if (typeof timestamp !== 'string') throw oxygenContractError();
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(timestamp);
  if (!match) throw oxygenContractError();
  const [, date, h, m, s, fraction = '', zone] = match;
  oxygenCivilDate(date);
  if (+h > 23 || +m > 59 || +s > 59) throw oxygenContractError();
  let offset = 0;
  if (zone !== 'Z') {
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(4));
    if (hours > 23 || minutes > 59) throw oxygenContractError();
    offset = (hours * 60 + minutes) * 60 * (zone[0] === '-' ? -1 : 1);
  }
  const seconds = BigInt(Date.parse(`${date}T00:00:00Z`) / 1000 + +h * 3600 + +m * 60 + +s - offset);
  return seconds * SECOND + BigInt(fraction.padEnd(9, '0'));
}

export function parseOxygenTime(sampleTime) {
  if (!sampleTime || typeof sampleTime !== 'object') throw oxygenContractError();
  const epochNanoseconds = oxygenInstantNanoseconds(sampleTime.physicalTime);
  const offset = typeof sampleTime.utcOffset === 'string'
    && /^(-?)(\d+)(?:\.(\d{1,9}))?s$/.exec(sampleTime.utcOffset);
  if (!offset) throw oxygenContractError();
  const offsetNanos = (BigInt(offset[2]) * SECOND + BigInt((offset[3] ?? '').padEnd(9, '0')))
    * (offset[1] ? -1n : 1n);
  if (offsetNanos <= -DAY || offsetNanos >= DAY) throw oxygenContractError();
  const civilNanos = epochNanoseconds + offsetNanos;
  const civilDate = new Date(Number(floorDivide(civilNanos, DAY)) * 86_400_000).toISOString().slice(0, 10);
  oxygenCivilDate(civilDate);
  if (sampleTime.civilTime != null) {
    const civil = sampleTime.civilTime;
    if (oxygenCivilDate(civil.date) !== civilDate) throw oxygenContractError();
    {
      if (civil.time != null && (typeof civil.time !== 'object' || Array.isArray(civil.time))) throw oxygenContractError();
      const { hours = 0, minutes = 0, seconds = 0, nanos = 0 } = civil.time ?? {};
      if (![hours, minutes, seconds, nanos].every(Number.isInteger)
        || hours < 0 || hours > 23 || minutes < 0 || minutes > 59
        || seconds < 0 || seconds > 59 || nanos < 0 || nanos >= 1e9) throw oxygenContractError();
      const sinceMidnight = civilNanos - floorDivide(civilNanos, DAY) * DAY;
      if (sinceMidnight !== BigInt(hours * 3600 + minutes * 60 + seconds) * SECOND + BigInt(nanos)) {
        throw oxygenContractError();
      }
    }
  }
  return { sampledAt: sampleTime.physicalTime, epochNanoseconds, civilDate,
    utcOffsetSeconds: Number(offsetNanos) / 1e9 };
}

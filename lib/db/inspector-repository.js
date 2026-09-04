const CALORIE_DATA_TYPES = Object.freeze({
  active: 'active-energy-burned',
  basal: 'basal-energy-burned',
  total: 'total-calories',
});

const CALORIE_FIELD_DEFINITIONS = Object.freeze([
  { field: 'metricType', type: 'enum', meaning: 'active, basal, or total energy stream' },
  { field: 'startTime', type: 'RFC 3339 timestamp', meaning: 'interval start' },
  { field: 'endTime', type: 'RFC 3339 timestamp', meaning: 'interval end' },
  { field: 'utcOffsetSeconds', type: 'integer or null', unit: 'seconds', meaning: 'source civil-time offset' },
  { field: 'kilocalories', type: 'number', unit: 'kcal', meaning: 'energy assigned to the interval' },
  { field: 'device', type: 'object', meaning: 'source-supplied device description when available' },
]);

const HEART_FIELD_DEFINITIONS = Object.freeze([
  { field: 'sampledAt', type: 'RFC 3339 timestamp', meaning: 'heart-rate sample time' },
  { field: 'utcOffsetSeconds', type: 'integer or null', unit: 'seconds', meaning: 'source civil-time offset' },
  { field: 'beatsPerMinute', type: 'number', unit: 'bpm', meaning: 'source-supplied heart-rate sample' },
  { field: 'device', type: 'object', meaning: 'source-supplied device description when available' },
]);

const SLEEP_FIELD_DEFINITIONS = Object.freeze([
  { field: 'sequence', type: 'integer', meaning: 'stored chronological stage position' },
  { field: 'stageType', type: 'enum', meaning: 'awake, light, deep, REM, asleep, or source-supplied stage' },
  { field: 'startTime', type: 'RFC 3339 timestamp', meaning: 'stage interval start' },
  { field: 'endTime', type: 'RFC 3339 timestamp', meaning: 'stage interval end' },
  { field: 'durationMinutes', type: 'number', unit: 'minutes', meaning: 'stored duration converted from seconds' },
]);

const REDACTED = '[redacted]';

function sensitiveKey(key) {
  const normalized = String(key).replaceAll(/[^a-z0-9]/gi, '').toLowerCase();
  return normalized === 'id'
    || normalized === 'name'
    || normalized.endsWith('id')
    || normalized.endsWith('identifier')
    || normalized === 'providerkey'
    || normalized === 'datapointname'
    || normalized.includes('accountidentifier')
    || normalized.includes('authorization')
    || normalized.includes('credential')
    || normalized.includes('password')
    || normalized.includes('secret')
    || normalized.includes('token')
    || normalized.includes('oauth')
    || normalized.includes('apikey')
    || normalized.includes('encryptionkey')
    || normalized === 'filepath'
    || normalized === 'userpath'
    || normalized === 'homedirectory'
    || normalized === 'objectkey';
}

function sensitiveString(value) {
  return /^\s*bearer\s+/i.test(value)
    || /^[a-z]:\\users\\/i.test(value)
    || /^\/(?:home|users)\//i.test(value);
}

export function redactSourceJson(value, key = '') {
  if (sensitiveKey(key)) return REDACTED;
  if (Array.isArray(value)) return value.map((entry) => redactSourceJson(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entry]) => [
        entryKey,
        redactSourceJson(entry, entryKey),
      ]),
    );
  }
  if (typeof value === 'string' && sensitiveString(value)) return REDACTED;
  return value;
}

function numeric(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function latestIso(...values) {
  return values
    .flat()
    .map(iso)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
}

function dateOnly(value) {
  if (!value) return null;
  return typeof value === 'string' ? value.slice(0, 10) : new Date(value).toISOString().slice(0, 10);
}

function round(value, precision = 2) {
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function minutes(value) {
  const seconds = numeric(value);
  return seconds === null ? null : round(seconds / 60);
}

function shiftDate(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function zonedParts(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function localMidnightUtc(date, timeZone) {
  const [year, month, day] = date.split('-').map(Number);
  const wanted = Date.UTC(year, month - 1, day);
  let timestamp = wanted;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = zonedParts(timestamp, timeZone);
    const represented = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const adjustment = wanted - represented;
    timestamp += adjustment;
    if (adjustment === 0) break;
  }
  return timestamp;
}

export function civilDayWindow(date, timeZone) {
  const startMs = localMidnightUtc(date, timeZone);
  const endMs = localMidnightUtc(shiftDate(date, 1), timeZone);
  return {
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(endMs).toISOString(),
    civilDaySeconds: Math.round((endMs - startMs) / 1000),
  };
}

export function intervalCoverage(intervals, window) {
  const startBoundary = Date.parse(window.startTime);
  const endBoundary = Date.parse(window.endTime);
  const merged = intervals
    .map(({ startTime, endTime }) => [
      Math.max(startBoundary, Date.parse(startTime)),
      Math.min(endBoundary, Date.parse(endTime)),
    ])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort(([left], [right]) => left - right)
    .reduce((result, [start, end]) => {
      const previous = result.at(-1);
      if (previous && start <= previous[1]) {
        previous[1] = Math.max(previous[1], end);
      } else {
        result.push([start, end]);
      }
      return result;
    }, []);
  const coverageSeconds = Math.round(
    merged.reduce((total, [start, end]) => total + end - start, 0) / 1000,
  );
  const gaps = [];
  let cursor = startBoundary;
  for (const [start, end] of merged) {
    if (start > cursor) {
      gaps.push({
        startTime: new Date(cursor).toISOString(),
        endTime: new Date(start).toISOString(),
        durationSeconds: Math.round((start - cursor) / 1000),
      });
    }
    cursor = Math.max(cursor, end);
  }
  if (cursor < endBoundary) {
    gaps.push({
      startTime: new Date(cursor).toISOString(),
      endTime: new Date(endBoundary).toISOString(),
      durationSeconds: Math.round((endBoundary - cursor) / 1000),
    });
  }
  return {
    coverageSeconds,
    gapSeconds: Math.max(0, window.civilDaySeconds - coverageSeconds),
    gaps,
  };
}

function calorieCursorKey(row) {
  return `${iso(row.start_time)}\u0000${row.metric_type}`;
}

function encodeCursor(key, scope) {
  return Buffer.from(JSON.stringify({ v: 1, scope, key }), 'utf8').toString('base64url');
}

function invalidCursor() {
  const error = new Error('cursor is invalid for this inspector page');
  error.status = 400;
  return error;
}

function decodeCursor(value, scope) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (parsed?.v !== 1 || parsed.scope !== scope || typeof parsed.key !== 'string') {
      throw invalidCursor();
    }
    return parsed.key;
  } catch {
    throw invalidCursor();
  }
}

function pageRows(
  rows,
  { cursor = null, limit = 100, maximumLimit = 200, defaultLimit = 100 } = {},
  keyForRow = calorieCursorKey,
  scope = 'inspector',
) {
  const boundedLimit = Math.max(1, Math.min(maximumLimit, Number(limit) || defaultLimit));
  const after = decodeCursor(cursor, scope);
  const occurrences = new Map();
  const keyedRows = rows.map((row) => {
    const baseKey = keyForRow(row);
    const occurrence = occurrences.get(baseKey) ?? 0;
    occurrences.set(baseKey, occurrence + 1);
    return {
      key: `${baseKey}\u0000${String(occurrence).padStart(8, '0')}`,
      row,
    };
  });
  const followingIndex = after === null
    ? 0
    : keyedRows.findIndex(({ key }) => key > after);
  const startIndex = followingIndex < 0 ? keyedRows.length : followingIndex;
  const page = keyedRows.slice(startIndex, startIndex + boundedLimit);
  const items = page.map(({ row }) => row);
  const hasMore = startIndex + items.length < keyedRows.length;
  return {
    rows: items,
    nextCursor: hasMore && items.length
      ? encodeCursor(page.at(-1).key, scope)
      : null,
  };
}

function calorieRecord(row) {
  return {
    metricType: row.metric_type,
    startTime: iso(row.start_time),
    endTime: iso(row.end_time),
    utcOffsetSeconds: numeric(row.utc_offset_seconds),
    kilocalories: numeric(row.kilocalories),
    device: redactSourceJson(row.device ?? {}),
  };
}

function heartRecord(row) {
  return {
    sampledAt: iso(row.sampled_at),
    utcOffsetSeconds: numeric(row.utc_offset_seconds),
    beatsPerMinute: numeric(row.beats_per_minute),
    device: redactSourceJson(row.device ?? {}),
  };
}

function sleepStageRecord(row) {
  return {
    sequence: numeric(row.sequence),
    stageType: row.stage_type,
    startTime: iso(row.start_time),
    endTime: iso(row.end_time),
    durationMinutes: minutes(row.duration_seconds),
  };
}

function inputState(value) {
  return value === null || value === undefined ? 'missing' : 'present';
}

function streamCoverage(name, rows, window) {
  const matching = rows.filter(({ metric_type: type }) => type === name);
  const coverage = intervalCoverage(
    matching.map((row) => ({ startTime: row.start_time, endTime: row.end_time })),
    window,
  );
  const values = matching.map(({ kilocalories }) => numeric(kilocalories));
  return {
    name,
    dataType: CALORIE_DATA_TYPES[name],
    recordCount: matching.length,
    coverageSeconds: coverage.coverageSeconds,
    gapSeconds: coverage.gapSeconds,
    gaps: coverage.gaps,
    valueState: matching.length === 0
      ? 'missing'
      : values.every((value) => value === 0)
        ? 'zero'
        : 'present',
    zeroSemantics: matching.length && values.every((value) => value === 0)
      ? 'Google returned zero-valued intervals. This does not prove the device was worn.'
      : 'Missing intervals are not treated as measured zero.',
  };
}

function uniqueDevices(rows) {
  const devices = new Map();
  for (const row of rows) {
    const device = row.device ?? {};
    const key = JSON.stringify(device);
    if (key !== '{}' && !devices.has(key)) devices.set(key, redactSourceJson(device));
  }
  return [...devices.values()];
}

function uniqueSourceMetadata(values) {
  const metadata = new Map();
  for (const value of values) {
    if (!value || typeof value !== 'object' || !Object.keys(value).length) continue;
    const redacted = redactSourceJson(value);
    const key = JSON.stringify(redacted);
    if (!metadata.has(key)) metadata.set(key, redacted);
  }
  return [...metadata.values()];
}

function hasSourceFields(value) {
  return Boolean(value && typeof value === 'object' && Object.keys(value).length);
}

function missingCategory(category, date, timezone, { lastSuccessfulSync = null } = {}) {
  const window = civilDayWindow(date, timezone);
  return {
    category,
    date,
    timezone,
    status: 'missing',
    dataAge: {
      lastSuccessfulSync,
      normalizedUpdatedAt: null,
      sourceUpdatedAt: null,
    },
    sourceFacts: {
      dataTypes: [],
      recordCount: 0,
      window: { startTime: null, endTime: null },
      unit: category === 'calories' ? 'kcal' : null,
      devices: [],
    },
    normalized: { fieldDefinitions: [], summary: null },
    derived: [],
    coverage: {
      storedState: 'missing',
      storedCoverageSeconds: 0,
      civilDaySeconds: window.civilDaySeconds,
      streams: [],
      limitations: ['No normalized or source records are stored for this date.'],
    },
    records: { items: [], total: 0, nextCursor: null },
    sourceJson: {
      state: 'unavailable',
      recordCount: 0,
      format: 'redacted JSON',
      reason: 'No retained source payload is available for this date.',
    },
  };
}

export function createDataInspectorRepository(pool) {
  async function account() {
    return (
      await pool.query(
        `SELECT id, timezone
         FROM source_accounts
         ORDER BY created_at
         LIMIT 1`,
      )
    ).rows[0] ?? null;
  }

  async function lastSuccessfulSync() {
    const row = (
      await pool.query(
        `SELECT finished_at
         FROM sync_jobs
         WHERE status = 'completed'
         ORDER BY finished_at DESC
         LIMIT 1`,
      )
    ).rows[0];
    return iso(row?.finished_at);
  }

  async function archiveEntry(sourceAccountId, date) {
    return (
      await pool.query(
        `SELECT state
         FROM health_archive_catalog
         WHERE source_account_id = $1
           AND archive_month = $2
           AND is_active = true
         ORDER BY archive_version DESC
         LIMIT 1`,
        [sourceAccountId, `${date.slice(0, 7)}-01`],
      )
    ).rows[0] ?? null;
  }

  function sourceUnavailableReason(archive) {
    return archive?.state === 'pruned'
      ? 'The original payload is retained in an encrypted archive and is not reconstructed by the inspector.'
      : 'Only normalized or daily summary data remains online; the original payload is unavailable.';
  }

  async function calories(source, date, options) {
    const [summaryResult, intervalResult, syncedAt, archive] = await Promise.all([
      pool.query(
        `SELECT *
         FROM calorie_daily_summaries
         WHERE source_account_id = $1 AND civil_date = $2`,
        [source.id, date],
      ),
      pool.query(
        `SELECT metric_type, start_time, end_time, utc_offset_seconds, kilocalories,
                device, source_fields, updated_at
         FROM calorie_intervals
         WHERE source_account_id = $1 AND civil_date = $2
         ORDER BY start_time, metric_type`,
        [source.id, date],
      ),
      lastSuccessfulSync(),
      archiveEntry(source.id, date),
    ]);
    const summary = summaryResult.rows[0] ?? null;
    const rows = intervalResult.rows;
    if (!summary && rows.length === 0) {
      return missingCategory('calories', date, source.timezone, {
        lastSuccessfulSync: syncedAt,
      });
    }

    const window = civilDayWindow(date, source.timezone);
    const page = pageRows(rows, options, calorieCursorKey, `calories:records:${date}`);
    const activeKcal = numeric(summary?.active_kcal);
    const basalKcal = numeric(summary?.basal_kcal);
    const totalKcal = numeric(summary?.total_kcal);
    const totalDerived = Boolean(summary?.total_derived);
    const streamNames = ['active', 'basal', 'total'];
    const availableTypes = streamNames
      .filter((name) => rows.some(({ metric_type: type }) => type === name))
      .map((name) => CALORIE_DATA_TYPES[name]);

    return {
      category: 'calories',
      date,
      timezone: source.timezone,
      status: rows.length ? 'available' : 'partial',
      dataAge: {
        lastSuccessfulSync: syncedAt,
        normalizedUpdatedAt: latestIso(
          summary?.updated_at,
          rows.map(({ updated_at: value }) => value),
        ),
        sourceUpdatedAt: latestIso(rows.map(({ updated_at: value }) => value)),
      },
      sourceFacts: {
        dataTypes: availableTypes,
        recordCount: rows.length,
        window: {
          startTime: rows.length ? iso(rows[0].start_time) : null,
          endTime: rows.length
            ? rows.map(({ end_time: value }) => iso(value)).sort().at(-1)
            : null,
        },
        unit: 'kcal',
        devices: uniqueDevices(rows),
        metadata: uniqueSourceMetadata(
          rows.map(({ source_fields: fields }) => fields?.dataSource),
        ),
      },
      normalized: {
        fieldDefinitions: CALORIE_FIELD_DEFINITIONS,
        summary: {
          totalKcal,
          activeKcal,
          basalKcal,
          intervalCount: numeric(summary?.interval_count) ?? rows.length,
          totalDerived,
        },
      },
      derived: totalDerived
        ? [{
            field: 'totalKcal',
            value: totalKcal,
            unit: 'kcal',
            formula: 'activeKcal + basalKcal',
            inputFields: ['activeKcal', 'basalKcal'],
            inputState: {
              activeKcal: inputState(activeKcal),
              basalKcal: inputState(basalKcal),
            },
          }]
        : [],
      coverage: {
        storedState: rows.length ? 'source-and-normalized' : 'summary-only',
        storedCoverageSeconds: numeric(summary?.coverage_seconds) ?? 0,
        civilDaySeconds: window.civilDaySeconds,
        streams: streamNames.map((name) => streamCoverage(name, rows, window)),
        limitations: [
          'Coverage is calculated separately for each retained calorie stream.',
          'Google does not expose defensible sensor-level attribution for active energy.',
        ],
      },
      records: {
        items: page.rows.map(calorieRecord),
        total: rows.length,
        nextCursor: page.nextCursor,
      },
      sourceJson: {
        state: rows.length ? 'original' : 'unavailable',
        recordCount: rows.length,
        format: 'redacted JSON',
        reason: rows.length ? null : sourceUnavailableReason(archive),
      },
    };
  }

  async function heart(source, date, options) {
    const [summaryResult, sampleResult, syncedAt, archive] = await Promise.all([
      pool.query(
        `SELECT *
         FROM heart_rate_daily_summaries
         WHERE source_account_id = $1 AND civil_date = $2`,
        [source.id, date],
      ),
      pool.query(
        `SELECT sampled_at, utc_offset_seconds, beats_per_minute, device,
                source_fields, updated_at
         FROM heart_rate_samples
         WHERE source_account_id = $1 AND civil_date = $2
         ORDER BY sampled_at, beats_per_minute`,
        [source.id, date],
      ),
      lastSuccessfulSync(),
      archiveEntry(source.id, date),
    ]);
    const summary = summaryResult.rows[0] ?? null;
    const rows = sampleResult.rows;
    if (!summary && rows.length === 0) {
      return missingCategory('heart', date, source.timezone, {
        lastSuccessfulSync: syncedAt,
      });
    }

    const window = civilDayWindow(date, source.timezone);
    const page = pageRows(
      rows,
      options,
      (row) => `${iso(row.sampled_at)}\u0000${String(row.beats_per_minute).padStart(10, '0')}`,
      `heart:records:${date}`,
    );
    const buckets = new Map();
    for (const row of rows) {
      const sampledAt = Date.parse(row.sampled_at);
      if (!Number.isFinite(sampledAt)) continue;
      const start = Math.floor(sampledAt / 300_000) * 300_000;
      buckets.set(start, {
        startTime: new Date(start).toISOString(),
        endTime: new Date(start + 300_000).toISOString(),
      });
    }
    const rawCoverage = intervalCoverage([...buckets.values()], window);
    const restingDerived = Boolean(summary?.resting_derived);
    const dailySourceAvailable = hasSourceFields(summary?.source_fields);
    const sourceAvailable = rows.length > 0 || dailySourceAvailable;
    const dataTypes = [];
    if (rows.length) dataTypes.push('heart-rate');
    if (numeric(summary?.resting_bpm) !== null && !restingDerived) {
      dataTypes.push('daily-resting-heart-rate');
    }
    const summaryValues = {
      restingBpm: numeric(summary?.resting_bpm),
      averageBpm: numeric(summary?.average_bpm),
      minimumBpm: numeric(summary?.minimum_bpm),
      maximumBpm: numeric(summary?.maximum_bpm),
      sampleCount: numeric(summary?.sample_count) ?? rows.length,
      coverageSeconds: numeric(summary?.coverage_seconds) ?? 0,
      restingDerived,
      bpmSum: numeric(summary?.bpm_sum),
      bpmSumOfSquares: numeric(summary?.bpm_sum_of_squares),
      populationStandardDeviationBpm: numeric(summary?.population_standard_deviation_bpm),
      percentilesBpm: {
        p05: numeric(summary?.p05_bpm),
        median: numeric(summary?.median_bpm),
        p95: numeric(summary?.p95_bpm),
      },
      aggregationVersion: numeric(summary?.aggregation_version),
      finalizedAt: iso(summary?.finalized_at),
    };
    const sampleInputState = rows.length ? 'present' : 'missing';

    return {
      category: 'heart',
      date,
      timezone: source.timezone,
      status: rows.length ? 'available' : 'partial',
      dataAge: {
        lastSuccessfulSync: syncedAt,
        normalizedUpdatedAt: latestIso(
          summary?.updated_at,
          rows.map(({ updated_at: value }) => value),
        ),
        sourceUpdatedAt: rows.length
          ? latestIso(rows.map(({ updated_at: value }) => value))
          : dailySourceAvailable
            ? iso(summary?.updated_at)
            : null,
      },
      sourceFacts: {
        dataTypes,
        recordCount: rows.length + (dailySourceAvailable ? 1 : 0),
        window: {
          startTime: rows.length ? iso(rows[0].sampled_at) : null,
          endTime: rows.length ? iso(rows.at(-1).sampled_at) : null,
        },
        unit: 'bpm',
        devices: uniqueDevices(rows),
        metadata: uniqueSourceMetadata([
          ...rows.map(({ source_fields: fields }) => fields?.dataSource),
          summary?.source_fields?.dataSource,
        ]),
      },
      normalized: {
        fieldDefinitions: HEART_FIELD_DEFINITIONS,
        summary: summaryValues,
      },
      derived: [
        ...(restingDerived
          ? [{
              field: 'restingBpm',
              value: summaryValues.restingBpm,
              unit: 'bpm',
              formula: 'application resting-heart-rate derivation',
              inputFields: ['heart-rate samples'],
              inputState: { samples: sampleInputState },
            }]
          : []),
        {
          field: 'averageBpm',
          value: summaryValues.averageBpm,
          unit: 'bpm',
          formula: 'sum(beatsPerMinute) / sampleCount',
          inputFields: ['beatsPerMinute', 'sampleCount'],
          inputState: { samples: sampleInputState },
        },
        {
          field: 'minimumBpm',
          value: summaryValues.minimumBpm,
          unit: 'bpm',
          formula: 'min(beatsPerMinute)',
          inputFields: ['beatsPerMinute'],
          inputState: { samples: sampleInputState },
        },
        {
          field: 'maximumBpm',
          value: summaryValues.maximumBpm,
          unit: 'bpm',
          formula: 'max(beatsPerMinute)',
          inputFields: ['beatsPerMinute'],
          inputState: { samples: sampleInputState },
        },
        {
          field: 'sampleCount',
          value: summaryValues.sampleCount,
          unit: 'samples',
          formula: 'count(heart-rate samples)',
          inputFields: ['heart-rate samples'],
          inputState: { samples: sampleInputState },
        },
        {
          field: 'coverageSeconds',
          value: summaryValues.coverageSeconds,
          unit: 'seconds',
          formula: 'occupied 5-minute buckets × 300 seconds',
          inputFields: ['sampledAt'],
          inputState: { samples: sampleInputState },
        },
        {
          field: 'populationStandardDeviationBpm',
          value: summaryValues.populationStandardDeviationBpm,
          unit: 'bpm',
          formula: 'sqrt(mean(bpm²) - mean(bpm)²)',
          inputFields: ['bpmSum', 'bpmSumOfSquares', 'sampleCount'],
          inputState: { exactAggregates: summaryValues.bpmSum === null ? 'missing' : 'present' },
        },
        {
          field: 'percentilesBpm',
          value: summaryValues.percentilesBpm,
          unit: 'bpm',
          formula: 'continuous p05, p50, and p95 of daily samples',
          inputFields: ['beatsPerMinute'],
          inputState: {
            percentiles: summaryValues.percentilesBpm.median === null ? 'missing' : 'present',
          },
        },
      ],
      coverage: {
        storedState: rows.length ? 'source-and-normalized' : 'summary-only',
        storedCoverageSeconds: summaryValues.coverageSeconds,
        civilDaySeconds: window.civilDaySeconds,
        streams: [{
          name: 'heart-rate',
          dataType: 'heart-rate',
          recordCount: rows.length,
          coverageSeconds: rawCoverage.coverageSeconds,
          gapSeconds: rawCoverage.gapSeconds,
          gaps: rawCoverage.gaps,
          valueState: rows.length ? 'present' : 'missing',
          zeroSemantics: 'Heart-rate samples must be positive; no samples means missing, not zero bpm.',
        }],
        limitations: [
          'Inspector coverage counts occupied 5-minute buckets and does not interpolate between samples.',
          'Resting heart rate is labelled separately because Google may supply it as a daily inferred value.',
        ],
      },
      records: {
        items: page.rows.map(heartRecord),
        total: rows.length,
        nextCursor: page.nextCursor,
      },
      sourceJson: {
        state: sourceAvailable ? 'original' : 'unavailable',
        recordCount: rows.length + (dailySourceAvailable ? 1 : 0),
        format: 'redacted JSON',
        reason: sourceAvailable ? null : sourceUnavailableReason(archive),
      },
    };
  }

  async function sleep(source, date, options) {
    const [sessionResult, syncedAt] = await Promise.all([
      pool.query(
        `SELECT *
         FROM sleep_sessions
         WHERE source_account_id = $1 AND civil_date = $2 AND is_nap = false
         ORDER BY duration_seconds DESC
         LIMIT 1`,
        [source.id, date],
      ),
      lastSuccessfulSync(),
    ]);
    const session = sessionResult.rows[0] ?? null;
    if (!session) {
      return missingCategory('sleep', date, source.timezone, {
        lastSuccessfulSync: syncedAt,
      });
    }
    const stages = (
      await pool.query(
        `SELECT sequence, stage_type, start_time, end_time, duration_seconds, source_fields
         FROM sleep_stages
         WHERE sleep_session_id = $1
         ORDER BY sequence, start_time`,
        [session.id],
      )
    ).rows;
    const page = pageRows(
      stages,
      options,
      (row) => `${String(row.sequence).padStart(8, '0')}\u0000${iso(row.start_time)}`,
      `sleep:records:${date}`,
    );
    const sessionWindow = {
      startTime: iso(session.start_time),
      endTime: iso(session.end_time),
      civilDaySeconds: Math.max(
        0,
        Math.round((Date.parse(session.end_time) - Date.parse(session.start_time)) / 1000),
      ),
    };
    const stageCoverage = intervalCoverage(
      stages.map((stage) => ({ startTime: stage.start_time, endTime: stage.end_time })),
      sessionWindow,
    );
    const stageMinutes = {};
    for (const stage of stages) {
      stageMinutes[stage.stage_type] ??= 0;
      stageMinutes[stage.stage_type] += minutes(stage.duration_seconds) ?? 0;
    }
    const durationMinutes = minutes(session.duration_seconds);
    const stagePercentages = Object.fromEntries(
      Object.entries(stageMinutes).map(([type, value]) => [
        type,
        durationMinutes ? round((value / durationMinutes) * 100, 1) : null,
      ]),
    );
    const summary = {
      date: dateOnly(session.civil_date),
      startTime: iso(session.start_time),
      endTime: iso(session.end_time),
      startOffsetSeconds: numeric(session.start_offset_seconds),
      endOffsetSeconds: numeric(session.end_offset_seconds),
      sleepType: session.sleep_type,
      isNap: Boolean(session.is_nap),
      durationMinutes,
      minutesAsleep: minutes(session.asleep_seconds),
      minutesAwake: minutes(session.awake_seconds),
      efficiency: numeric(session.efficiency),
      timeToSleepMinutes: minutes(session.time_to_sleep_seconds),
      awakeEpisodes: numeric(session.awake_episodes),
      device: redactSourceJson(session.device ?? {}),
    };

    return {
      category: 'sleep',
      date,
      timezone: source.timezone,
      status: 'available',
      dataAge: {
        lastSuccessfulSync: syncedAt,
        normalizedUpdatedAt: iso(session.updated_at),
        sourceUpdatedAt: iso(session.updated_at),
      },
      sourceFacts: {
        dataTypes: ['sleep'],
        recordCount: 1,
        window: { startTime: summary.startTime, endTime: summary.endTime },
        unit: 'minutes',
        devices: Object.keys(summary.device).length ? [summary.device] : [],
        metadata: uniqueSourceMetadata([session.source_fields?.source]),
      },
      normalized: {
        fieldDefinitions: SLEEP_FIELD_DEFINITIONS,
        summary,
      },
      derived: [
        {
          field: 'durationMinutes',
          value: summary.durationMinutes,
          unit: 'minutes',
          formula: 'stored durationSeconds / 60',
          inputFields: ['durationSeconds'],
          inputState: { durationSeconds: inputState(session.duration_seconds) },
        },
        {
          field: 'minutesAsleep',
          value: summary.minutesAsleep,
          unit: 'minutes',
          formula: 'stored asleepSeconds / 60',
          inputFields: ['asleepSeconds'],
          inputState: { asleepSeconds: inputState(session.asleep_seconds) },
        },
        {
          field: 'minutesAwake',
          value: summary.minutesAwake,
          unit: 'minutes',
          formula: 'stored awakeSeconds / 60',
          inputFields: ['awakeSeconds'],
          inputState: { awakeSeconds: inputState(session.awake_seconds) },
        },
        {
          field: 'efficiency',
          value: summary.efficiency,
          unit: 'percent',
          formula: 'minutesAsleep / durationMinutes × 100',
          inputFields: ['minutesAsleep', 'durationMinutes'],
          inputState: {
            minutesAsleep: inputState(summary.minutesAsleep),
            durationMinutes: inputState(summary.durationMinutes),
          },
        },
        {
          field: 'stagePercentages',
          value: stagePercentages,
          unit: 'percent',
          formula: 'stage minutes / durationMinutes × 100',
          inputFields: ['stage durationMinutes', 'durationMinutes'],
          inputState: { stages: stages.length ? 'present' : 'missing' },
        },
        {
          field: 'awakeEpisodes',
          value: summary.awakeEpisodes,
          unit: 'episodes',
          formula: 'count(awake stage intervals)',
          inputFields: ['sleep stages'],
          inputState: { stages: stages.length ? 'present' : 'missing' },
        },
      ],
      coverage: {
        storedState: 'normalized-source',
        storedCoverageSeconds: stageCoverage.coverageSeconds,
        civilDaySeconds: civilDayWindow(date, source.timezone).civilDaySeconds,
        streams: [{
          name: 'sleep-stages',
          dataType: 'sleep',
          recordCount: stages.length,
          coverageSeconds: stageCoverage.coverageSeconds,
          gapSeconds: stageCoverage.gapSeconds,
          gaps: stageCoverage.gaps,
          valueState: stages.length ? 'present' : 'missing',
          zeroSemantics: 'No stage intervals means stage detail is missing; it is not zero sleep.',
        }],
        limitations: [
          'Stage coverage is compared with the stored sleep session, not with the full civil day.',
          'The retained sleep source_fields contain the application-normalized representation, not untouched Google JSON.',
        ],
      },
      records: {
        items: page.rows.map(sleepStageRecord),
        total: stages.length,
        nextCursor: page.nextCursor,
      },
      sourceJson: {
        state: 'normalized-only',
        recordCount: 1 + stages.length,
        format: 'redacted JSON',
        reason: 'This pipeline retained an application-normalized representation rather than the original Google payload.',
      },
    };
  }

  async function sourcePage(source, category, date, options) {
    const scope = `${category}:source:${date}`;
    let rows = [];
    let state = 'unavailable';
    let reason = null;

    if (category === 'calories') {
      const result = await pool.query(
        `SELECT metric_type, start_time, end_time, source_fields
         FROM calorie_intervals
         WHERE source_account_id = $1 AND civil_date = $2
         ORDER BY start_time, metric_type`,
        [source.id, date],
      );
      rows = result.rows.map((row) => ({
        _cursorKey: `${iso(row.start_time)}\u0000${row.metric_type}`,
        recordType: 'interval',
        dataType: CALORIE_DATA_TYPES[row.metric_type],
        locator: {
          startTime: iso(row.start_time),
          endTime: iso(row.end_time),
          metricType: row.metric_type,
        },
        source: redactSourceJson(row.source_fields ?? {}),
      }));
      if (rows.length) state = 'original';
    } else if (category === 'heart') {
      const [summaryResult, sampleResult, archive] = await Promise.all([
        pool.query(
          `SELECT resting_bpm, resting_derived, source_fields
           FROM heart_rate_daily_summaries
           WHERE source_account_id = $1 AND civil_date = $2`,
          [source.id, date],
        ),
        pool.query(
          `SELECT sampled_at, source_fields
           FROM heart_rate_samples
           WHERE source_account_id = $1 AND civil_date = $2
           ORDER BY sampled_at`,
          [source.id, date],
        ),
        archiveEntry(source.id, date),
      ]);
      const summary = summaryResult.rows[0];
      if (
        summary
        && !summary.resting_derived
        && numeric(summary.resting_bpm) !== null
        && hasSourceFields(summary.source_fields)
      ) {
        rows.push({
          _cursorKey: '0:daily-resting-heart-rate',
          recordType: 'daily-summary',
          dataType: 'daily-resting-heart-rate',
          locator: { date },
          source: redactSourceJson(summary.source_fields),
        });
      }
      rows.push(
        ...sampleResult.rows.map((row) => ({
          _cursorKey: `1:${iso(row.sampled_at)}`,
          recordType: 'sample',
          dataType: 'heart-rate',
          locator: { sampledAt: iso(row.sampled_at) },
          source: redactSourceJson(row.source_fields ?? {}),
        })),
      );
      if (rows.length) {
        state = 'original';
      } else {
        reason = sourceUnavailableReason(archive);
      }
    } else if (category === 'sleep') {
      const session = (
        await pool.query(
          `SELECT id, start_time, end_time, source_fields
           FROM sleep_sessions
           WHERE source_account_id = $1 AND civil_date = $2 AND is_nap = false
           ORDER BY duration_seconds DESC
           LIMIT 1`,
          [source.id, date],
        )
      ).rows[0];
      if (session) {
        const stages = (
          await pool.query(
            `SELECT sequence, stage_type, start_time, end_time, source_fields
             FROM sleep_stages
             WHERE sleep_session_id = $1
             ORDER BY sequence, start_time`,
            [session.id],
          )
        ).rows;
        rows = [
          {
            _cursorKey: '0:session',
            recordType: 'session',
            dataType: 'sleep',
            locator: {
              startTime: iso(session.start_time),
              endTime: iso(session.end_time),
            },
            source: redactSourceJson(session.source_fields ?? {}),
          },
          ...stages.map((row) => ({
            _cursorKey: `1:${String(row.sequence).padStart(8, '0')}:${iso(row.start_time)}`,
            recordType: 'stage',
            dataType: 'sleep',
            locator: {
              sequence: numeric(row.sequence),
              stageType: row.stage_type,
              startTime: iso(row.start_time),
              endTime: iso(row.end_time),
            },
            source: redactSourceJson(row.source_fields ?? {}),
          })),
        ];
        state = 'normalized-only';
        reason = 'This pipeline retained an application-normalized representation rather than the original Google payload.';
      }
    }

    if (state === 'unavailable' && !reason) {
      reason = 'No retained source payload is available for this date.';
    }
    const page = pageRows(
      rows,
      {
        ...options,
        maximumLimit: 50,
        defaultLimit: 20,
      },
      (row) => row._cursorKey,
      scope,
    );
    return {
      category,
      date,
      timezone: source.timezone,
      state,
      format: 'redacted JSON',
      reason,
      items: page.rows.map(({ _cursorKey, ...item }) => item),
      total: rows.length,
      nextCursor: page.nextCursor,
    };
  }

  return {
    async getInspector(category, date, options = {}) {
      const source = await account();
      const timezone = source?.timezone ?? 'America/Toronto';
      if (!source) return missingCategory(category, date, timezone);
      if (category === 'calories') return calories(source, date, options);
      if (category === 'heart') return heart(source, date, options);
      if (category === 'sleep') return sleep(source, date, options);
      throw new Error(`Unsupported inspector category: ${category}`);
    },
    async getInspectorSource(category, date, options = {}) {
      const source = await account();
      if (!source) {
        return {
          category,
          date,
          timezone: 'America/Toronto',
          state: 'unavailable',
          format: 'redacted JSON',
          reason: 'No source account or retained payload is available.',
          items: [],
          total: 0,
          nextCursor: null,
        };
      }
      return sourcePage(source, category, date, options);
    },
  };
}

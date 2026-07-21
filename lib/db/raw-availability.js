const RAW_TABLES = Object.freeze({
  heart: 'heart_rate_samples',
  calories: 'calorie_intervals',
});

function dateOnly(value) {
  if (!value) return null;
  return typeof value === 'string' ? value.slice(0, 10) : new Date(value).toISOString().slice(0, 10);
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function shiftDate(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function shiftMonth(month, months) {
  const value = new Date(`${month.slice(0, 7)}-01T12:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + months);
  return value.toISOString().slice(0, 10);
}

function monthsInRange(startDate, endDateExclusive) {
  const months = [];
  for (let month = `${startDate.slice(0, 7)}-01`; month < endDateExclusive; month = shiftMonth(month, 1)) {
    months.push(month);
  }
  return months;
}

function intersectsMonth(month, startDate, endDateExclusive) {
  return month < endDateExclusive && shiftMonth(month, 1) > startDate;
}

function calculateHotCutoff(today, retentionDays) {
  const eligibleThrough = shiftDate(today, -retentionDays);
  const month = `${eligibleThrough.slice(0, 7)}-01`;
  const lastDay = shiftDate(shiftMonth(month, 1), -1);
  return lastDay <= eligibleThrough ? shiftMonth(month, 1) : month;
}

function safeCatalog(row) {
  return {
    month: dateOnly(row.archive_month),
    version: number(row.archive_version),
    state: row.state,
    heartSampleCount: number(row.heart_sample_count),
    calorieIntervalCount: number(row.calorie_interval_count),
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    verifiedAt: iso(row.verified_at),
    prunedAt: iso(row.pruned_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function createRawAvailabilityReader(pool, {
  archiveConfigured = false,
  archivePruningEnabled = false,
  retentionDays = 90,
  now = () => Date.now(),
} = {}) {
  const memoryDatabase = pool.constructor?.name === 'MemPg';
  const dateText = (expression, alias) => memoryDatabase
    ? `${expression} AS ${alias}`
    : `${expression}::text AS ${alias}`;
  async function catalog(sourceAccountId, { limit = null, descending = false } = {}) {
    const boundedLimit = limit === null ? null : Math.max(1, Math.min(500, Number(limit) || 120));
    const params = [sourceAccountId];
    if (boundedLimit !== null) params.push(boundedLimit + 1);
    const result = await pool.query(
      `SELECT ${dateText('archive_month', 'archive_month')}, archive_version, state, heart_sample_count,
              calorie_interval_count, error_code, error_message, verified_at,
              pruned_at, created_at, updated_at
       FROM health_archive_catalog
       WHERE source_account_id = $1 AND is_active = true
       ORDER BY archive_month ${descending ? 'DESC' : 'ASC'}, archive_version ${descending ? 'DESC' : 'ASC'}
       ${boundedLimit === null ? '' : 'LIMIT $2'}`,
      params,
    );
    const rows = result.rows.map(safeCatalog);
    return boundedLimit === null ? rows : rows.slice(0, boundedLimit);
  }

  async function exactBounds(sourceAccountId, metric, range = null) {
    const table = RAW_TABLES[metric];
    if (!table) throw new Error(`Unsupported raw metric: ${metric}`);
    const rangeSql = range ? ' AND civil_date >= $2 AND civil_date < $3' : '';
    const result = await pool.query(
      `SELECT ${dateText('MIN(civil_date)', 'retained_from')},
              ${dateText('MAX(civil_date)', 'retained_through')},
              COUNT(*) AS row_count
       FROM ${table}
       WHERE source_account_id = $1${rangeSql}`,
      range ? [sourceAccountId, range.startDate, range.endDateExclusive] : [sourceAccountId],
    );
    return {
      retainedFrom: dateOnly(result.rows[0]?.retained_from),
      retainedThrough: dateOnly(result.rows[0]?.retained_through),
      rowCount: number(result.rows[0]?.row_count),
    };
  }

  async function exactMonths(sourceAccountId, metric, range) {
    const table = RAW_TABLES[metric];
    const result = await pool.query(
      `SELECT DISTINCT ${dateText('civil_date', 'civil_date')}
       FROM ${table}
       WHERE source_account_id = $1 AND civil_date >= $2 AND civil_date < $3`,
      [sourceAccountId, range.startDate, range.endDateExclusive],
    );
    return new Set(result.rows.map(({ civil_date: date }) => dateOnly(date).slice(0, 7) + '-01'));
  }

  async function lastVerifiedMonth(sourceAccountId) {
    const result = await pool.query(
      `SELECT ${dateText('MAX(archive_month)', 'archive_month')}
       FROM health_archive_catalog
       WHERE source_account_id = $1 AND is_active = true
         AND state IN ('verified', 'pruning', 'pruned')`,
      [sourceAccountId],
    );
    return dateOnly(result.rows[0]?.archive_month);
  }

  return {
    async heartRange(sourceAccountId, range) {
      const bounds = await exactBounds(sourceAccountId, 'heart');
      const entries = await catalog(sourceAccountId);
      const cold = entries.filter(
        (entry) => entry.state === 'pruned' && intersectsMonth(entry.month, range.startDate, range.endDateExclusive),
      );
      return {
        retainedFrom: bounds.retainedFrom,
        requestedRangeFullyRaw: Boolean(
          bounds.retainedFrom && range.startDate >= bounds.retainedFrom && cold.length === 0,
        ),
        coldArchiveMonth: cold[0]?.month ?? null,
      };
    },

    async exportCoverage(sourceAccountId, range, metrics) {
      const requestedRawMetrics = ['heart', 'calories'].filter((metric) => metrics.includes(metric));
      const entries = await catalog(sourceAccountId);
      const exactLocal = {};
      const localMonthsByMetric = new Map();
      for (const metric of requestedRawMetrics) {
        const bounds = await exactBounds(sourceAccountId, metric, range);
        const months = await exactMonths(sourceAccountId, metric, range);
        exactLocal[metric] = bounds;
        localMonthsByMetric.set(metric, months);
      }
      const coldArchiveMonths = requestedRawMetrics.length
        ? entries.filter(
            (entry) => ['verified', 'pruning', 'pruned'].includes(entry.state)
              && intersectsMonth(entry.month, range.startDate, range.endDateExclusive)
              && requestedRawMetrics.some((metric) => metric === 'heart'
                ? entry.heartSampleCount > 0
                : entry.calorieIntervalCount > 0),
          )
        : [];
      const summaryOnlyCoverage = requestedRawMetrics.length
        ? monthsInRange(range.startDate, range.endDateExclusive).flatMap((month) => {
            const archived = coldArchiveMonths.filter((entry) => entry.month === month);
            const missingMetrics = requestedRawMetrics.filter((metric) => {
              const requestedMonthStart = month < range.startDate ? range.startDate : month;
              const firstLocalDate = exactLocal[metric]?.retainedFrom;
              const local = localMonthsByMetric.get(metric)?.has(month)
                && firstLocalDate
                && firstLocalDate <= requestedMonthStart;
              const cold = archived.some((entry) => metric === 'heart'
                ? entry.heartSampleCount > 0
                : entry.calorieIntervalCount > 0);
              return !local && !cold;
            });
            return missingMetrics.length ? [{ month, metrics: missingMetrics }] : [];
          })
        : [];
      const summaryOnlyMonths = summaryOnlyCoverage.map(({ month }) => month);
      return { exactLocal, coldArchiveMonths, summaryOnlyMonths, summaryOnlyCoverage };
    },

    async archiveStatus(sourceAccountId) {
      const entries = await catalog(sourceAccountId, { limit: 120, descending: true });
      const verifiedMonth = await lastVerifiedMonth(sourceAccountId);
      return {
        configured: Boolean(archiveConfigured),
        pruningEnabled: Boolean(archivePruningEnabled),
        retentionDays,
        hotCutoff: calculateHotCutoff(new Date(now()).toISOString().slice(0, 10), retentionDays),
        lastVerifiedMonth: verifiedMonth,
        pendingMonths: entries.filter((entry) => ['pending', 'building', 'uploaded', 'pruning'].includes(entry.state)),
        failedMonths: entries.filter((entry) => entry.state === 'failed'),
        catalog: entries,
        catalogLimit: 120,
      };
    },
  };
}

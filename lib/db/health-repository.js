function numeric(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function minutes(seconds) {
  const value = numeric(seconds);
  return value === null ? null : Math.round(value / 60);
}

function round(value, precision = 2) {
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function missingHeart() {
  return {
    restingBpm: null,
    averageBpm: null,
    minimumBpm: null,
    maximumBpm: null,
    sampleCount: 0,
    coverageSeconds: 0,
    missing: true,
    derived: { resting: false },
  };
}

function missingCalories() {
  return {
    totalKcal: null,
    activeKcal: null,
    basalKcal: null,
    intervalCount: 0,
    coverageSeconds: 0,
    missing: true,
    derived: { total: false },
  };
}

export function createHealthRepository(pool) {
  async function account() {
    return (
      await pool.query(`
        SELECT id, timezone, membership_start_date
        FROM source_accounts
        ORDER BY created_at
        LIMIT 1
      `)
    ).rows[0] ?? null;
  }

  async function getSleep(sourceAccountId, date) {
    const result = await pool.query(
      `SELECT *
       FROM sleep_sessions
       WHERE source_account_id = $1 AND civil_date = $2 AND is_nap = false
       ORDER BY duration_seconds DESC
       LIMIT 1`,
      [sourceAccountId, date],
    );
    const session = result.rows[0];
    if (!session) return null;

    const stagesResult = await pool.query(
      `SELECT *
       FROM sleep_stages
       WHERE sleep_session_id = $1
       ORDER BY sequence, start_time`,
      [session.id],
    );
    const stageSummary = {};
    const stages = stagesResult.rows.map((stage) => {
      const durationMinutes = minutes(stage.duration_seconds) ?? 0;
      const type = stage.stage_type;
      stageSummary[type] ??= { minutes: 0, episodes: 0 };
      stageSummary[type].minutes += durationMinutes;
      stageSummary[type].episodes += 1;
      return {
        id: stage.id,
        type,
        startTime: iso(stage.start_time),
        endTime: iso(stage.end_time),
        durationMinutes,
      };
    });

    return {
      id: session.id,
      date: dateOnly(session.civil_date),
      startTime: iso(session.start_time),
      endTime: iso(session.end_time),
      startOffsetSeconds: numeric(session.start_offset_seconds),
      endOffsetSeconds: numeric(session.end_offset_seconds),
      type: session.sleep_type,
      durationMinutes: minutes(session.duration_seconds),
      minutesAsleep: minutes(session.asleep_seconds),
      minutesAwake: minutes(session.awake_seconds),
      efficiency: numeric(session.efficiency),
      timeToSleepMinutes: minutes(session.time_to_sleep_seconds),
      awakeEpisodes: numeric(session.awake_episodes),
      stageSummary,
      stages,
      missing: false,
    };
  }

  async function getHeart(sourceAccountId, date) {
    const row = (
      await pool.query(
        `SELECT * FROM heart_rate_daily_summaries
         WHERE source_account_id = $1 AND civil_date = $2`,
        [sourceAccountId, date],
      )
    ).rows[0];
    if (!row) return missingHeart();
    return {
      restingBpm: numeric(row.resting_bpm),
      averageBpm: numeric(row.average_bpm),
      minimumBpm: numeric(row.minimum_bpm),
      maximumBpm: numeric(row.maximum_bpm),
      sampleCount: numeric(row.sample_count) ?? 0,
      coverageSeconds: numeric(row.coverage_seconds) ?? 0,
      missing: false,
      derived: { resting: Boolean(row.resting_derived) },
    };
  }

  async function getCalories(sourceAccountId, date) {
    const row = (
      await pool.query(
        `SELECT * FROM calorie_daily_summaries
         WHERE source_account_id = $1 AND civil_date = $2`,
        [sourceAccountId, date],
      )
    ).rows[0];
    if (!row) return missingCalories();
    return {
      totalKcal: numeric(row.total_kcal),
      activeKcal: numeric(row.active_kcal),
      basalKcal: numeric(row.basal_kcal),
      intervalCount: numeric(row.interval_count) ?? 0,
      coverageSeconds: numeric(row.coverage_seconds) ?? 0,
      missing: false,
      derived: { total: Boolean(row.total_derived) },
    };
  }

  return {
    async getDashboard(date) {
      const source = await account();
      if (!source) {
        return {
          date,
          timezone: 'America/Toronto',
          sleep: null,
          heart: missingHeart(),
          calories: missingCalories(),
          journal: [],
          coverage: { sleep: 'missing', heart: 'missing', calories: 'missing' },
          sync: { lastSuccessfulSync: null, stale: true },
        };
      }

      const [sleep, heart, calories, daily] = await Promise.all([
        getSleep(source.id, date),
        getHeart(source.id, date),
        getCalories(source.id, date),
        pool.query(
          `SELECT coverage, derivations FROM daily_health_summaries
           WHERE source_account_id = $1 AND civil_date = $2`,
          [source.id, date],
        ),
      ]);
      const coverage = daily.rows[0]?.coverage ?? {
        sleep: sleep ? 'complete' : 'missing',
        heart: heart.missing ? 'missing' : 'complete',
        calories: calories.missing ? 'missing' : 'complete',
      };
      const lastSync = (
        await pool.query(
          `SELECT finished_at FROM sync_jobs
           WHERE status = 'completed'
           ORDER BY finished_at DESC
           LIMIT 1`,
        )
      ).rows[0]?.finished_at;

      return {
        date,
        timezone: source.timezone,
        membershipStartDate: dateOnly(source.membership_start_date),
        sleep,
        heart,
        calories,
        journal: [],
        coverage,
        derivations: daily.rows[0]?.derivations ?? {},
        sync: {
          lastSuccessfulSync: iso(lastSync),
          stale: !lastSync || Date.now() - new Date(lastSync).getTime() > 4 * 60 * 60 * 1000,
        },
      };
    },

    async getSleepRange(startDate, endDateExclusive) {
      const source = await account();
      if (!source) return { startDate, endDateExclusive, timezone: 'America/Toronto', sessions: [] };
      const dates = await pool.query(
        `SELECT civil_date
         FROM sleep_sessions
         WHERE source_account_id = $1
           AND civil_date >= $2
           AND civil_date < $3
           AND is_nap = false
         GROUP BY civil_date
         ORDER BY civil_date DESC`,
        [source.id, startDate, endDateExclusive],
      );
      const sessions = await Promise.all(
        dates.rows.map(({ civil_date: date }) => getSleep(source.id, dateOnly(date))),
      );
      return {
        startDate,
        endDateExclusive,
        timezone: source.timezone,
        sessions: sessions.filter(Boolean),
      };
    },

    async getHeartRange(startDate, endDateExclusive, resolution = 'day') {
      const source = await account();
      if (!source) {
        return { startDate, endDateExclusive, timezone: 'America/Toronto', resolution, days: [], points: [] };
      }
      if (resolution === 'day') {
        const result = await pool.query(
          `SELECT *
           FROM heart_rate_daily_summaries
           WHERE source_account_id = $1
             AND civil_date >= $2
             AND civil_date < $3
           ORDER BY civil_date`,
          [source.id, startDate, endDateExclusive],
        );
        return {
          startDate,
          endDateExclusive,
          timezone: source.timezone,
          resolution,
          days: result.rows.map((row) => ({
            date: dateOnly(row.civil_date),
            restingBpm: numeric(row.resting_bpm),
            averageBpm: numeric(row.average_bpm),
            minimumBpm: numeric(row.minimum_bpm),
            maximumBpm: numeric(row.maximum_bpm),
            sampleCount: numeric(row.sample_count) ?? 0,
            coverageSeconds: numeric(row.coverage_seconds) ?? 0,
            missing: false,
          })),
        };
      }

      const samples = await pool.query(
        `SELECT sampled_at, beats_per_minute
         FROM heart_rate_samples
         WHERE source_account_id = $1
           AND civil_date >= $2
           AND civil_date < $3
         ORDER BY sampled_at`,
        [source.id, startDate, endDateExclusive],
      );
      const buckets = new Map();
      for (const sample of samples.rows) {
        const timestamp = new Date(sample.sampled_at).getTime();
        const bucketTime = Math.floor(timestamp / 300_000) * 300_000;
        const bpm = numeric(sample.beats_per_minute);
        const bucket = buckets.get(bucketTime) ?? { values: [] };
        bucket.values.push(bpm);
        buckets.set(bucketTime, bucket);
      }
      const points = [...buckets.entries()].map(([time, bucket]) => ({
        time: new Date(time).toISOString(),
        averageBpm: round(bucket.values.reduce((sum, value) => sum + value, 0) / bucket.values.length, 1),
        minimumBpm: Math.min(...bucket.values),
        maximumBpm: Math.max(...bucket.values),
        count: bucket.values.length,
      }));
      return {
        startDate,
        endDateExclusive,
        timezone: source.timezone,
        resolution: 'five-minute',
        summary: await getHeart(source.id, startDate),
        points,
      };
    },

    async getCaloriesRange(startDate, endDateExclusive, resolution = 'day') {
      const source = await account();
      if (!source) {
        return { startDate, endDateExclusive, timezone: 'America/Toronto', resolution, days: [], intervals: [] };
      }
      if (resolution === 'day') {
        const result = await pool.query(
          `SELECT *
           FROM calorie_daily_summaries
           WHERE source_account_id = $1
             AND civil_date >= $2
             AND civil_date < $3
           ORDER BY civil_date`,
          [source.id, startDate, endDateExclusive],
        );
        return {
          startDate,
          endDateExclusive,
          timezone: source.timezone,
          resolution,
          days: result.rows.map((row) => ({
            date: dateOnly(row.civil_date),
            totalKcal: numeric(row.total_kcal),
            activeKcal: numeric(row.active_kcal),
            basalKcal: numeric(row.basal_kcal),
            intervalCount: numeric(row.interval_count) ?? 0,
            coverageSeconds: numeric(row.coverage_seconds) ?? 0,
            missing: false,
            derived: { total: Boolean(row.total_derived) },
          })),
        };
      }

      const result = await pool.query(
        `SELECT metric_type, start_time, kilocalories
         FROM calorie_intervals
         WHERE source_account_id = $1
           AND civil_date >= $2
           AND civil_date < $3
         ORDER BY start_time`,
        [source.id, startDate, endDateExclusive],
      );
      const buckets = new Map();
      for (const interval of result.rows) {
        const time = new Date(interval.start_time).toISOString();
        const bucket = buckets.get(time) ?? { time, activeKcal: 0, basalKcal: 0, totalKcal: 0 };
        const value = numeric(interval.kilocalories) ?? 0;
        if (interval.metric_type === 'active') bucket.activeKcal += value;
        if (interval.metric_type === 'basal') bucket.basalKcal += value;
        if (interval.metric_type === 'total') bucket.totalKcal += value;
        buckets.set(time, bucket);
      }
      const intervals = [...buckets.values()].map((bucket) => ({
        time: bucket.time,
        activeKcal: round(bucket.activeKcal),
        basalKcal: round(bucket.basalKcal),
        totalKcal: round(bucket.totalKcal || bucket.activeKcal + bucket.basalKcal),
      }));
      return {
        startDate,
        endDateExclusive,
        timezone: source.timezone,
        resolution: 'hour',
        summary: await getCalories(source.id, startDate),
        intervals,
      };
    },
  };
}

export const oxygenSource = {
  recordingMethod: 'PASSIVELY_MEASURED',
  device: { manufacturer: 'Fixture', displayName: 'Test watch', formFactor: 'WATCH' },
};

export const oxygenAccountId = '75ce6554-70c7-48be-a688-d0079384fcb1';

export async function createOxygenDatabase() {
  const { newDb } = await import('pg-mem');
  const { applyMigrations } = await import('../lib/db/migrations.js');
  const memory = newDb({ noAstCoverageCheck: true });
  const pool = new (memory.adapters.createPg().Pool)();
  await applyMigrations(pool);
  await pool.query(`INSERT INTO source_accounts (id, provider, provider_account_id, timezone, membership_start_date)
    VALUES ($1, 'google-health', 'oxygen-fixture', 'America/Toronto', '2024-01-01')`, [oxygenAccountId]);
  return pool;
}

export function oxygenPoint({ id = 'sample-1', time = '2026-09-07T03:59:00Z',
  percentage = 96.25, offset = '-14400s', dataSource = oxygenSource } = {}) {
  return {
    name: `users/me/dataTypes/oxygen-saturation/dataPoints/${id}`, dataSource,
    oxygenSaturation: { sampleTime: { physicalTime: time, utcOffset: offset }, percentage },
  };
}

export function oxygenDailyPoint({ id = 'daily-1', date = { year: 2026, month: 9, day: 7 },
  average = 96.25, lower = 93.125, upper = 98.75, sd = 0.7, dataSource = oxygenSource } = {}) {
  return {
    name: `users/me/dataTypes/daily-oxygen-saturation/dataPoints/${id}`, dataSource,
    dailyOxygenSaturation: { date, averagePercentage: average,
      lowerBoundPercentage: lower, upperBoundPercentage: upper, standardDeviationPercentage: sd },
  };
}

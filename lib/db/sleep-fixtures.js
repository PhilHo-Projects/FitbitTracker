import { createSleepVitalsWriter } from "./sleep-vitals-writer.js";
import { normalizeSleepVitals } from "../metrics/sleep-vitals.js";
import { shiftDate } from "../sleep/analysis.js";

// Preview-only augmentation. Never used by live sync or migrations.
export async function seedSleepOverviewFixtures(pool, { anchorDate }) {
  const account = (
    await pool.query(
      "SELECT id,profile FROM source_accounts WHERE provider_account_id='fixture-account'",
    )
  ).rows[0];
  if (!account?.profile?.fixture)
    throw new Error("Sleep preview requires the synthetic fixture account");
  const writer = createSleepVitalsWriter(pool),
    dataSource = { device: { displayName: "Synthetic preview watch" } };
  for (let i = 0; i < 8; i++) {
    const date = shiftDate(anchorDate, -i),
      [year, month, day] = date.split("-").map(Number),
      civil = { year, month, day };
    for (const [metric, property, value] of [
      [
        "daily-heart-rate-variability",
        "dailyHeartRateVariability",
        {
          date: civil,
          averageHeartRateVariabilityMilliseconds: 42 + i,
          nonRemHeartRateBeatsPerMinute: 58,
        },
      ],
      [
        "daily-respiratory-rate",
        "dailyRespiratoryRate",
        { date: civil, breathsPerMinute: 14.2 + i * 0.1 },
      ],
      [
        "daily-sleep-temperature-derivations",
        "dailySleepTemperatureDerivations",
        {
          date: civil,
          nightlyTemperatureCelsius: 33.5 + i * 0.05,
          baselineTemperatureCelsius: 33.4,
        },
      ],
    ])
      await writer.upsertSleepVitals(
        account.id,
        metric,
        normalizeSleepVitals(metric, {
          dataPoints: [
            {
              dataPointName: `preview-${metric}-${date}`,
              dataSource,
              [property]: value,
            },
          ],
        }),
      );
    if (i !== 2)
      await writer.upsertSleepVitals(
        account.id,
        "heart-rate-variability",
        normalizeSleepVitals("heart-rate-variability", {
          dataPoints: Array.from({ length: 70 }, (_, n) => ({
            dataPointName: `preview-hrv-${date}-${n}`,
            dataSource,
            heartRateVariability: {
              sampleTime: {
                physicalTime: new Date(
                  Date.parse(`${date}T03:20:00Z`) + n * 300000,
                ).toISOString(),
                utcOffset: "-14400s",
              },
              rootMeanSquareOfSuccessiveDifferencesMilliseconds:
                42 + Math.sin(n / 6) * 8,
            },
          })).filter((_, n) => n < 30 || n > 35),
        }),
      );
  }
}

/**
 * Seed one account shaped like a multi-year Apple Health `export.xml` import,
 * for reproducing the maintenance jobs at the size a real heavy account
 * reaches (issue #1031: about 1.26 million measurement rows).
 *
 *   DATABASE_URL=postgresql://… pnpm dlx tsx scripts/seed-large-account.ts \
 *     [--user bench-large] [--years 4] [--pulse-seconds 165]
 *
 * Never point this at a database that holds real data: it inserts rows under
 * the given user id and, with `--reset`, deletes that user first.
 *
 * The shape follows what the import and the iOS sync actually write:
 *
 *   - dense spot rows (heart rate every `--pulse-seconds`, HRV, SpO2) keyed by
 *     a hashed sample id, the tier the dense-intraday retention folds;
 *   - high-frequency mean rows (respiratory rate, gait metrics, audio
 *     exposure), the tier the daily-mean consolidation folds;
 *   - one `stats:` daily row per cumulative type and day (what the export
 *     import writes for steps, energy, distance and flights);
 *   - per-sample cumulative rows with opaque sample ids for the most recent
 *     90 days (what the iOS sync writes, and what the cumulative drain folds);
 *   - sleep-stage segments every night.
 *
 * Everything is generated inside Postgres with `generate_series`, so a million
 * rows take seconds rather than a million round trips. `ANALYZE` runs at the
 * end: a planner reading pre-seed statistics picks plans no production table
 * of this size would get.
 */
import { prisma } from "@/lib/db";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const USER_ID = arg("user", "bench-large");
const YEARS = Number(arg("years", "4"));
const PULSE_SECONDS = Number(arg("pulse-seconds", "165"));
const RESET = process.argv.includes("--reset");

/** A spot series: `perDay` evenly spaced rows per day over the whole span. */
interface SpotSeries {
  type: string;
  unit: string;
  perDay: number;
  base: number;
  spread: number;
  /** Days back from now the series covers. Defaults to the whole span. */
  days?: number;
  /** externalId prefix; `stats:` rows are generated separately. */
  idPrefix: string;
}

async function insertSpot(s: SpotSeries, days: number): Promise<number> {
  const step = Math.floor(86_400 / s.perDay);
  const count = Math.floor((days * 86_400) / step);
  // Jitter stays below the step so every measured_at is distinct per type
  // (the (user, type, measured_at, source, sleep_stage) unique index).
  const jitter = Math.max(1, Math.min(59, step - 1));
  return prisma.$executeRawUnsafe(
    `
    INSERT INTO measurements
      (id, user_id, type, value, unit, source, measured_at, external_id, created_at, updated_at)
    SELECT
      'seed-' || $1 || '-' || $2 || '-' || g,
      $1,
      $2::measurement_type,
      round(($3 + $4 * sin(g / 37.0) + ($4 / 2) * ((g * 7919) % 100) / 100.0)::numeric, 2),
      $5,
      'APPLE_HEALTH',
      date_trunc('minute', now()) - make_interval(secs => $6 * $7::bigint)
        + make_interval(secs => g * $6 + (g * 31) % $8),
      $9 || md5($2 || g::text),
      now(), now()
    FROM generate_series(0, $7::bigint - 1) AS g
    `,
    USER_ID,
    s.type,
    s.base,
    s.spread,
    s.unit,
    step,
    count,
    jitter,
    s.idPrefix,
  );
}

async function main(): Promise<void> {
  const days = Math.round(YEARS * 365);

  if (RESET) {
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE id = $1`, USER_ID);
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (id, username, timezone, updated_at)
     VALUES ($1, $1, 'Europe/Berlin', now())
     ON CONFLICT (id) DO NOTHING`,
    USER_ID,
  );

  const pulsePerDay = Math.floor(86_400 / PULSE_SECONDS);
  const spot: SpotSeries[] = [
    {
      type: "PULSE",
      unit: "bpm",
      perDay: pulsePerDay,
      base: 62,
      spread: 25,
      idPrefix: "hk-",
    },
    {
      type: "HEART_RATE_VARIABILITY",
      unit: "ms",
      perDay: 12,
      base: 45,
      spread: 20,
      idPrefix: "hk-",
    },
    {
      type: "OXYGEN_SATURATION",
      unit: "%",
      perDay: 24,
      base: 96,
      spread: 2,
      idPrefix: "hk-",
    },
    {
      type: "RESPIRATORY_RATE",
      unit: "breaths/min",
      perDay: 48,
      base: 14,
      spread: 3,
      idPrefix: "hk-",
    },
    {
      type: "WALKING_SPEED",
      unit: "km/h",
      perDay: 30,
      base: 4.8,
      spread: 0.8,
      idPrefix: "hk-",
    },
    {
      type: "WALKING_STEP_LENGTH",
      unit: "cm",
      perDay: 30,
      base: 72,
      spread: 6,
      idPrefix: "hk-",
    },
    {
      type: "WALKING_ASYMMETRY",
      unit: "%",
      perDay: 30,
      base: 3,
      spread: 2,
      idPrefix: "hk-",
    },
    {
      type: "WALKING_DOUBLE_SUPPORT",
      unit: "%",
      perDay: 30,
      base: 28,
      spread: 3,
      idPrefix: "hk-",
    },
    {
      type: "AUDIO_EXPOSURE_ENV",
      unit: "dB",
      perDay: 60,
      base: 62,
      spread: 12,
      idPrefix: "hk-",
    },
    // The iOS sync's per-sample cumulative rows: dense, recent, opaque ids.
    {
      type: "ACTIVITY_STEPS",
      unit: "steps",
      perDay: 100,
      base: 90,
      spread: 60,
      days: 90,
      idPrefix: "uuid-",
    },
    {
      type: "ACTIVE_ENERGY_BURNED",
      unit: "kcal",
      perDay: 400,
      base: 1.2,
      spread: 0.9,
      days: 90,
      idPrefix: "uuid-",
    },
    {
      type: "WALKING_RUNNING_DISTANCE",
      unit: "m",
      perDay: 100,
      base: 70,
      spread: 50,
      days: 90,
      idPrefix: "uuid-",
    },
    {
      type: "WEIGHT",
      unit: "kg",
      perDay: 1,
      base: 82,
      spread: 1.5,
      idPrefix: "hk-",
    },
  ];

  let total = 0;
  for (const s of spot) {
    const n = await insertSpot(s, s.days ?? days);
    total += n;
    console.log(`${s.type.padEnd(28)} ${String(n).padStart(9)}`);
  }

  // One export-estimate `stats:` row per cumulative type and local day, at
  // local noon — what `flushCumulativeBuckets` in the export import writes.
  for (const [type, hk, unit, base] of [
    ["ACTIVITY_STEPS", "HKQuantityTypeIdentifierStepCount", "steps", 8000],
    [
      "ACTIVE_ENERGY_BURNED",
      "HKQuantityTypeIdentifierActiveEnergyBurned",
      "kcal",
      550,
    ],
    [
      "WALKING_RUNNING_DISTANCE",
      "HKQuantityTypeIdentifierDistanceWalkingRunning",
      "m",
      6000,
    ],
    ["FLIGHTS_CLIMBED", "HKQuantityTypeIdentifierFlightsClimbed", "count", 9],
  ] as const) {
    const n = await prisma.$executeRawUnsafe(
      `
      INSERT INTO measurements
        (id, user_id, type, value, unit, source, measured_at, external_id,
         aggregation_provenance, created_at, updated_at)
      SELECT
        'seed-' || $1 || '-' || $2 || '-stats-' || d,
        $1, $2::measurement_type, $5 + (d * 7919) % ($5 / 2), $4, 'APPLE_HEALTH',
        ((current_date - d)::timestamp + interval '12 hours')
          AT TIME ZONE 'Europe/Berlin' AT TIME ZONE 'UTC',
        'stats:' || $3 || ':' || to_char(current_date - d, 'YYYY-MM-DD'),
        'EXPORT_XML_SOURCE_MAX', now(), now()
      FROM generate_series(91, $6::int) AS d
      `,
      USER_ID,
      type,
      hk,
      unit,
      base,
      days,
    );
    total += n;
    console.log(`${`${type} (stats:)`.padEnd(28)} ${String(n).padStart(9)}`);
  }

  // Sleep: 30 segments a night from 23:00 local, 16 minutes apart, rotating
  // through the stages. Distinct measured_at per segment.
  const sleep = await prisma.$executeRawUnsafe(
    `
    INSERT INTO measurements
      (id, user_id, type, value, unit, source, measured_at, external_id,
       sleep_stage, created_at, updated_at)
    SELECT
      'seed-' || $1 || '-sleep-' || d || '-' || s,
      $1, 'SLEEP_DURATION', 16, 'minutes', 'APPLE_HEALTH',
      ((current_date - d)::timestamp - interval '1 hour' + s * interval '16 minutes')
        AT TIME ZONE 'Europe/Berlin' AT TIME ZONE 'UTC',
      'hk-' || md5('sleep' || d || '-' || s),
      (ARRAY['CORE','DEEP','CORE','REM','AWAKE','CORE']::sleep_stage[])[1 + s % 6],
      now(), now()
    FROM generate_series(1, $2::int) AS d, generate_series(0, 29) AS s
    `,
    USER_ID,
    days,
  );
  total += sleep;
  console.log(`${"SLEEP_DURATION".padEnd(28)} ${String(sleep).padStart(9)}`);

  await prisma.$executeRawUnsafe(`ANALYZE measurements`);
  console.log(`${"total".padEnd(28)} ${String(total).padStart(9)}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

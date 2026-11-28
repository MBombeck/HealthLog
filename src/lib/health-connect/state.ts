/**
 * `GET /api/health-connect/state`: what the phone needs before it reads.
 *
 * The change tokens stay on the phone; the server keeps no cursor, because a
 * cursor here would duplicate state only Health Connect can interpret. What
 * the server does know is what it holds, per record type, and the rules a
 * batch is held to, so the app reads them here instead of carrying them.
 */
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";
import { foldBoundary } from "@/lib/measurements/consolidation-tz";
import { loadFoldTimezone } from "@/lib/measurements/folded-window";
import { HC_RAW_PULSE_WINDOW_MS } from "@/lib/import/health-connect/mapper";
import {
  connectedDirectIntegrations,
  packagesToSkip,
} from "@/lib/import/health-connect/skip-packages";
import {
  HC_DAILY_METRICS,
  HC_SYNC_MAX_BYTES,
  HC_SYNC_MAX_ITEMS,
  HC_SYNC_MAX_SAMPLES,
  HC_SYNC_RECORD_TYPES,
  type HcSyncRecordType,
} from "@/lib/validations/health-connect-sync";

/** Batches per account per minute, the bucket the batch route enforces. */
export const HC_BATCHES_PER_MINUTE = 60;

/** The measurement type a record type's newest reading is read from. */
const NEWEST_TYPE: Record<
  Exclude<HcSyncRecordType, "ExerciseSessionRecord">,
  MeasurementType
> = {
  WeightRecord: "WEIGHT",
  BodyFatRecord: "BODY_FAT",
  LeanBodyMassRecord: "LEAN_BODY_MASS",
  BloodPressureRecord: "BLOOD_PRESSURE_SYS",
  RestingHeartRateRecord: "RESTING_HEART_RATE",
  HeartRateVariabilityRmssdRecord: "HRV_RMSSD",
  OxygenSaturationRecord: "OXYGEN_SATURATION",
  RespiratoryRateRecord: "RESPIRATORY_RATE",
  BloodGlucoseRecord: "BLOOD_GLUCOSE",
  BodyTemperatureRecord: "BODY_TEMPERATURE",
  Vo2MaxRecord: "VO2_MAX",
  HeartRateRecord: "PULSE",
  SleepSessionRecord: "SLEEP_DURATION",
};

export async function buildHealthConnectState(
  prisma: PrismaClient,
  input: { userId: string; tokenExpiresAt: Date | null; now?: Date },
) {
  const now = input.now ?? new Date();
  const types = Object.values(NEWEST_TYPE);
  const [integrations, tz, newest, workout] = await Promise.all([
    connectedDirectIntegrations(prisma, input.userId),
    loadFoldTimezone(prisma, input.userId),
    // One indexed probe per type: the newest live Health Connect row.
    prisma.$queryRaw<Array<{ type: MeasurementType; at: Date | null }>>`
      SELECT t.type::text AS type, m.measured_at AS at
        FROM unnest(${types}::text[]) AS t(type)
        LEFT JOIN LATERAL (
          SELECT measured_at FROM measurements
           WHERE user_id = ${input.userId}
             AND type = t.type::measurement_type
             AND source = 'HEALTH_CONNECT'::measurement_source
             AND deleted_at IS NULL
           ORDER BY measured_at DESC
           LIMIT 1
        ) m ON true`,
    prisma.workout.findFirst({
      where: { userId: input.userId, source: "HEALTH_CONNECT" },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true },
    }),
  ]);
  const byType = new Map(newest.map((r) => [r.type, r.at]));
  const typesOut: Record<string, { newestAt: string | null }> = {};
  for (const recordType of HC_SYNC_RECORD_TYPES) {
    const at =
      recordType === "ExerciseSessionRecord"
        ? (workout?.startedAt ?? null)
        : (byType.get(NEWEST_TYPE[recordType]) ?? null);
    typesOut[recordType] = { newestAt: at ? at.toISOString() : null };
  }

  return {
    serverNow: now.toISOString(),
    tokenExpiresAt: input.tokenExpiresAt?.toISOString() ?? null,
    wantedTypes: [...HC_SYNC_RECORD_TYPES],
    wantedAggregates: [...HC_DAILY_METRICS, "HEART_RATE_BPM"],
    skipPackages: [...packagesToSkip(integrations)].sort(),
    rawHeartRateDays: Math.round(HC_RAW_PULSE_WINDOW_MS / 86_400_000),
    // The instant the export import and the nightly fold split heart rate
    // at: day-aligned in the account's zone, so a day is never half raw.
    rawHeartRateFrom: foldBoundary(
      now,
      HC_RAW_PULSE_WINDOW_MS,
      tz,
    ).toISOString(),
    historyFrom: null,
    types: typesOut,
    limits: {
      maxItems: HC_SYNC_MAX_ITEMS,
      maxSamples: HC_SYNC_MAX_SAMPLES,
      maxBytes: HC_SYNC_MAX_BYTES,
      batchesPerMinute: HC_BATCHES_PER_MINUTE,
      backfillWindowDays: 7,
      maxInFlight: 1,
    },
  };
}

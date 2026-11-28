/**
 * The per-device delivery record the iPhone stall detector reads.
 *
 * The app reports no "last upload" of its own, and a value it reported would
 * be the least reliable one: the phone that stopped uploading is the phone
 * that would stop reporting. Every request it makes carries `X-Device-Id`
 * (the `Device.token` it registered), the ingest batches included, so the
 * server stamps the device itself when a batch it accepted carried Apple
 * Health data of a background type.
 *
 * Only the types iOS hands over while the app is in the background count
 * ({@link STALL_LIVENESS_TYPES}): steps, sleep, heart rate and the other
 * vitals, which the app observes with immediate background delivery. Energy,
 * flights, distance and VO2 max arrive only with the app in the foreground or
 * in a processing task, so a phone that sends only those is no evidence the
 * background path works, and their absence is no evidence it broke.
 *
 * The header is not a credential, so the write is confined to the caller's own
 * iOS devices: a forged value can at most stamp another device of the same
 * account.
 */
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";
import { hourBucket } from "./cadence";

/** The Apple Health types iOS delivers in the background, immediately. */
export const STALL_LIVENESS_TYPES: ReadonlySet<MeasurementType> = new Set([
  "ACTIVITY_STEPS",
  "SLEEP_DURATION",
  "PULSE",
  "RESTING_HEART_RATE",
  "WALKING_HEART_RATE_AVERAGE",
  "HEART_RATE_VARIABILITY",
  "OXYGEN_SATURATION",
  "RESPIRATORY_RATE",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "BLOOD_GLUCOSE",
  "BODY_TEMPERATURE",
  "WRIST_TEMPERATURE",
] satisfies MeasurementType[]);

/** Device tokens longer than this are not a registered token. */
const MAX_TOKEN_LENGTH = 512;

/**
 * Stamp the caller's device: its last delivery, the hour it delivered in, and
 * the end of any stall it was in. One statement, so the hour row and the
 * device stamp cannot disagree. Does nothing without a token, or when the
 * token names no iOS device of this account.
 */
export async function recordDeviceHealthIngest(
  prisma: Pick<PrismaClient, "$executeRaw">,
  input: { userId: string; deviceToken: string | null; at: Date },
): Promise<void> {
  const token = input.deviceToken?.trim();
  if (!token || token.length > MAX_TOKEN_LENGTH) return;
  const hour = hourBucket(input.at);
  await prisma.$executeRaw`
    WITH d AS (
      UPDATE "devices"
         SET "health_ingest_at" = ${input.at},
             "health_quiet_since" = NULL,
             "health_quiet_notified_at" = NULL
       WHERE "user_id" = ${input.userId}
         AND "token" = ${token}
         AND "platform" = 'ios'
      RETURNING "id"
    )
    INSERT INTO "device_health_ingest_hours" ("device_id", "hour")
    SELECT "id", ${hour} FROM d
    ON CONFLICT DO NOTHING`;
}

/**
 * The same stamp for an Android device running HealthLog Sync, named by its
 * row rather than a header: the batch route resolves the device from the
 * token it was paired with (`Device.apiTokenId`), so there is no header to
 * trust. The route calls it for a `live` batch that carried data, never for
 * the first import.
 */
export async function recordPairedDeviceIngest(
  prisma: Pick<PrismaClient, "$executeRaw">,
  input: { deviceId: string; at: Date },
): Promise<void> {
  const hour = hourBucket(input.at);
  await prisma.$executeRaw`
    WITH d AS (
      UPDATE "devices"
         SET "health_ingest_at" = ${input.at},
             "health_quiet_since" = NULL,
             "health_quiet_notified_at" = NULL,
             "last_seen" = ${input.at}
       WHERE "id" = ${input.deviceId}
         AND "platform" = 'android'
      RETURNING "id"
    )
    INSERT INTO "device_health_ingest_hours" ("device_id", "hour")
    SELECT "id", ${hour} FROM d
    ON CONFLICT DO NOTHING`;
}

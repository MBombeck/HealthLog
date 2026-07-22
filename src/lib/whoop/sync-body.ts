/**
 * WHOOP body-measurement sync. The body endpoint is a single object (not a
 * paginated collection): one self-reported profile snapshot carrying weight,
 * max heart rate, and height. Two destinations remain:
 *
 *   - `max_heart_rate` → `WhoopConnection.maxHeartRate` (a profile constant,
 *     not a time series — lives on the connection row, not a `Measurement`).
 *   - `height_meter` → `User.heightCm`, converted m→cm, written ONLY when the
 *     user has no height yet. A user-set height is never overwritten, and
 *     height is never minted as a `Measurement`.
 *
 * `weight_kilogram` is deliberately NOT ingested (v1.16.11). It is a
 * self-reported profile field, not a reading — the previous overwrite-in-
 * place row took a fresh `measuredAt` on every sync, so a stale manual
 * entry kept resurfacing as the newest weight "measurement" no matter
 * what the scale said. The sync now also removes the legacy
 * `whoop:body:weight` row once, so existing accounts heal themselves.
 *
 * Every write is field-by-field and idempotent across reruns. A per-resource
 * 403 soft-skips this data class (returns 0, leaves the connection connected)
 * rather than parking the whole integration — see `isCollectionForbidden`.
 */
import { fetchBodyMeasurement, mapBody } from "./client";
import {
  getValidToken,
  handleCollectionFetchError,
  markSynced,
} from "./sync-core";
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";

/**
 * Stable externalId the retired profile-weight ingestion wrote under —
 * kept only so the sync can clean the legacy row off existing accounts.
 */
export const WHOOP_BODY_WEIGHT_EXTERNAL_ID = "whoop:body:weight";

/**
 * The body measurement is a single profile snapshot — there is no incremental
 * window to seek, so this sync ignores `fullSync` (the incremental vs backfill
 * distinction the collection syncs honour). The `opts` parameter is accepted to
 * keep the `syncUserWhoop` loop signature uniform.
 */
export async function syncUserBody(
  userId: string,
  opts: { fullSync?: boolean } = {},
): Promise<number> {
  void opts;

  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return 0;

  let body: Awaited<ReturnType<typeof fetchBodyMeasurement>>;
  try {
    body = await fetchBodyMeasurement(tokenInfo.accessToken);
  } catch (err) {
    return handleCollectionFetchError("body", userId, err);
  }

  const mapped = mapBody(body);

  // Profile weight is NOT ingested (see the module header). Remove the
  // legacy overwrite row once; deleteMany is a no-op after the first
  // pass, keeping the sync idempotent.
  try {
    await prisma.measurement.deleteMany({
      where: {
        userId,
        type: "WEIGHT",
        source: "WHOOP",
        externalId: WHOOP_BODY_WEIGHT_EXTERNAL_ID,
      },
    });
  } catch (err) {
    getEvent()?.addWarning(
      `whoop: failed to clear the legacy profile-weight row for ${userId}: ${err}`,
    );
  }

  // Max heart rate → WhoopConnection.maxHeartRate (profile constant).
  if (mapped.maxHeartRate !== null) {
    try {
      await prisma.whoopConnection.update({
        where: { userId },
        data: { maxHeartRate: mapped.maxHeartRate },
      });
    } catch (err) {
      getEvent()?.addWarning(
        `whoop: failed to persist maxHeartRate for ${userId}: ${err}`,
      );
    }
  }

  // Height → User.heightCm, only when the user has no height yet. Never
  // overwrite a user-set value; never mint a Measurement.
  if (mapped.heightCm !== null) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { heightCm: true },
      });
      if (user && user.heightCm === null) {
        await prisma.user.update({
          where: { id: userId },
          data: { heightCm: mapped.heightCm },
        });
      }
    } catch (err) {
      getEvent()?.addWarning(
        `whoop: failed to seed heightCm for ${userId}: ${err}`,
      );
    }
  }

  await markSynced(userId);
  // No Measurement rows are minted here any more.
  return 0;
}

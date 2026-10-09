import type { MeasurementSource } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { DEFAULT_SOURCE_PRIORITY } from "@/lib/validations/source-priority";

/**
 * Every source a source-priority ladder can rank, in a stable order.
 *
 * Derived from the default ladders rather than listed by hand, so a source
 * added to a ladder is probed without a second edit here.
 */
export const RANKABLE_SOURCES: readonly MeasurementSource[] = Array.from(
  new Set(Object.values(DEFAULT_SOURCE_PRIORITY).flat()),
) as MeasurementSource[];

/**
 * The rankable sources this account actually has: a source it holds at least
 * one measurement from, or an integration it has connected that has not
 * delivered yet.
 *
 * Deleted (tombstoned) readings do not count. The Settings ladder lists only
 * these. Ranking a source the person has never
 * used decides nothing, and ten of them per metric buried the two that do.
 * The ladders themselves stay whole: hidden sources keep their slot, so a
 * source that starts delivering later lands where the ladder already put it.
 *
 * Each data probe is a `LIMIT 1` on the `(userId, source, measuredAt)` index,
 * so the cost is one index lookup per rankable source, not a scan.
 */
export async function getSourcesInUse(
  userId: string,
): Promise<MeasurementSource[]> {
  const [withData, user, withings, whoop, fitbit, googleHealth] =
    await Promise.all([
      Promise.all(
        RANKABLE_SOURCES.map((source) =>
          prisma.measurement
            .findFirst({
              // A deleted reading is not data: a source whose readings were
              // all deleted is no longer in use.
              where: { userId, source, deletedAt: null },
              select: { id: true },
            })
            .then((row) => (row ? source : null)),
        ),
      ),
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          polarAccessTokenEncrypted: true,
          ouraAccessTokenEncrypted: true,
          stravaAccessTokenEncrypted: true,
        },
      }),
      prisma.withingsConnection.findUnique({
        where: { userId },
        select: { userId: true },
      }),
      prisma.whoopConnection.findUnique({
        where: { userId },
        select: { userId: true },
      }),
      prisma.fitbitConnection.findUnique({
        where: { userId },
        select: { userId: true },
      }),
      prisma.googleHealthConnection.findUnique({
        where: { userId },
        select: { userId: true },
      }),
    ]);

  const inUse = new Set<MeasurementSource>(
    withData.filter((s): s is MeasurementSource => s !== null),
  );
  if (withings) inUse.add("WITHINGS");
  if (whoop) inUse.add("WHOOP");
  if (fitbit) inUse.add("FITBIT");
  if (googleHealth) inUse.add("GOOGLE_HEALTH");
  if (user?.polarAccessTokenEncrypted) inUse.add("POLAR");
  if (user?.ouraAccessTokenEncrypted) inUse.add("OURA");
  if (user?.stravaAccessTokenEncrypted) inUse.add("STRAVA");

  return RANKABLE_SOURCES.filter((s) => inUse.has(s));
}

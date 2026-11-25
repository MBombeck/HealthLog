import { prisma } from "@/lib/db";
import { readOuraScopeDenied } from "@/lib/oura/credentials";
import {
  hasRecoveryData,
  resolveRecoveryEmpty,
  type RecoveryEmptyReason,
} from "./recovery-empty";

/**
 * The recovery page's empty reason for one account. Reads the Oura
 * connection, and whether a device wrote a recovery score, only when no
 * other recovery type has a reading, so a page with data never pays for it.
 *
 * A device's `RECOVERY_SCORE` (WHOOP, Oura, Polar) leads the page, but the
 * type's summary also counts the readiness HealthLog stores each night
 * (`COMPUTED`), which the page does not show. So the device row is asked for
 * by source, and an account with only HealthLog's own still reads as empty.
 */
export async function loadRecoveryEmpty(
  userId: string,
  summaries: Record<string, { count?: number } | null | undefined>,
): Promise<RecoveryEmptyReason | null> {
  if (hasRecoveryData(summaries)) return null;
  const [user, deviceRecovery] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { ouraAccessTokenEncrypted: true, ouraScopeDenied: true },
    }),
    prisma.measurement.findFirst({
      where: {
        userId,
        type: "RECOVERY_SCORE",
        source: { not: "COMPUTED" },
        deletedAt: null,
      },
      select: { id: true },
    }),
  ]);
  if (deviceRecovery) return null;
  return resolveRecoveryEmpty(summaries, {
    connected: !!user?.ouraAccessTokenEncrypted,
    scopeDenied: readOuraScopeDenied(user?.ouraScopeDenied),
  });
}

/**
 * The ledger of Apple Health workouts and ECG recordings the phone reported
 * deleted (`AppleHealthTombstone`).
 *
 * Neither table has a tombstone column, so the by-external-ids deletes still
 * remove the rows outright. What they add is a line here, keyed on the
 * HealthKit sample id, and both ingests consult it before writing: a late
 * re-post of a deleted sample (an outbox the phone had not drained yet, a
 * history sweep that raced the delete) answers `duplicate` and writes
 * nothing. That is the rule a mood entry keeps with its `deletedAt`.
 *
 * Only `source = APPLE_HEALTH` rows are ever recorded and only that source is
 * ever checked: an id from another source, a bridge or a file import never
 * meets the ledger. No reader of workouts or recordings looks here, because
 * the rows it names no longer exist.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

/** The closed set of domains a tombstone belongs to. */
export const APPLE_HEALTH_TOMBSTONE_DOMAINS = ["workout", "ecg"] as const;
export type AppleHealthTombstoneDomain =
  (typeof APPLE_HEALTH_TOMBSTONE_DOMAINS)[number];

type TombstoneClient =
  | Pick<PrismaClient, "appleHealthTombstone">
  | Pick<Prisma.TransactionClient, "appleHealthTombstone">;

/**
 * Remember the given sample ids as deleted. Idempotent: an id already in the
 * ledger keeps its first deletion instant.
 */
export async function recordAppleHealthTombstones(
  db: TombstoneClient,
  userId: string,
  domain: AppleHealthTombstoneDomain,
  externalIds: readonly string[],
): Promise<void> {
  if (externalIds.length === 0) return;
  await db.appleHealthTombstone.createMany({
    data: externalIds.map((externalId) => ({ userId, domain, externalId })),
    skipDuplicates: true,
  });
}

/** The subset of `externalIds` the phone reported deleted earlier. */
export async function findAppleHealthTombstones(
  db: TombstoneClient,
  userId: string,
  domain: AppleHealthTombstoneDomain,
  externalIds: readonly string[],
): Promise<Set<string>> {
  if (externalIds.length === 0) return new Set();
  const rows = await db.appleHealthTombstone.findMany({
    where: { userId, domain, externalId: { in: [...new Set(externalIds)] } },
    select: { externalId: true },
  });
  return new Set(rows.map((r) => r.externalId));
}

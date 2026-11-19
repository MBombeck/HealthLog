/**
 * The workout summaries, with both backup ends in one file. GPS routes and
 * per-sample series do not travel, and the file's manifest says so.
 *
 * The Apple Health deletion ledger rides here too (`AppleHealthTombstone`):
 * the workout and ECG sample ids the phone reported deleted, so a late
 * re-post stays deleted. Like a mood entry's `deletedAt`, it travels in a
 * disaster-recovery file only; a portable export leaves deletions out.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { toJson } from "@/lib/db";
import type { RestoreContext } from "@/lib/export/restore-context";
import type { AppleHealthTombstoneDomain } from "@/lib/sync/apple-health-tombstones";

// ── Export ───────────────────────────────────────────────────────────────────

export interface WorkoutBackupEntry {
  /** Present in canonical DR payloads for manual workouts without externalId. */
  id?: string;
  createdAt?: string;
  updatedAt?: string;
  sportType: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  totalEnergyKcal: number | null;
  totalDistanceM: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  minHeartRate: number | null;
  stepCount: number | null;
  elevationM: number | null;
  pauseDurationSec: number | null;
  source: string;
  externalId: string | null;
  /** Canonical DR only; portable workout summaries keep their existing shape. */
  metadata?: Prisma.JsonValue;
  /** Canonical DR only, beside `metadata`: the source's own version marker. */
  externalSourceVersion?: string | null;
}

/** One Apple Health sample the phone reported deleted. */
export interface AppleHealthTombstoneBackupEntry {
  domain: string;
  externalId: string;
  /** When the phone reported the sample deleted. */
  createdAt: string;
}

/**
 * The workout slice of the records section: the summaries, and in a
 * disaster-recovery file the Apple Health deletion ledger.
 */
export async function buildWorkoutsBackupSlice(
  prisma: Pick<PrismaClient, "workout" | "appleHealthTombstone">,
  userId: string,
  disasterRecovery: boolean,
): Promise<{
  workouts: WorkoutBackupEntry[];
  appleHealthTombstones?: AppleHealthTombstoneBackupEntry[];
}> {
  const [workoutRows, tombstoneRows] = await Promise.all([
    prisma.workout.findMany({
      where: { userId },
      orderBy: [{ startedAt: "desc" }, { id: "asc" }],
    }),
    disasterRecovery
      ? prisma.appleHealthTombstone.findMany({
          where: { userId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { domain: true, externalId: true, createdAt: true },
        })
      : Promise.resolve(null),
  ]);

  const workouts: WorkoutBackupEntry[] = workoutRows.map((w) => ({
    ...(disasterRecovery
      ? {
          id: w.id,
          createdAt: w.createdAt.toISOString(),
          updatedAt: w.updatedAt.toISOString(),
          ...(w.metadata == null ? {} : { metadata: w.metadata }),
          externalSourceVersion: w.externalSourceVersion,
        }
      : {}),
    sportType: w.sportType,
    startedAt: w.startedAt.toISOString(),
    endedAt: w.endedAt.toISOString(),
    durationSec: w.durationSec,
    totalEnergyKcal: w.totalEnergyKcal,
    totalDistanceM: w.totalDistanceM,
    avgHeartRate: w.avgHeartRate,
    maxHeartRate: w.maxHeartRate,
    minHeartRate: w.minHeartRate,
    stepCount: w.stepCount,
    elevationM: w.elevationM,
    pauseDurationSec: w.pauseDurationSec,
    source: w.source,
    externalId: w.externalId,
  }));
  if (!tombstoneRows) return { workouts };
  return {
    workouts,
    appleHealthTombstones: tombstoneRows.map((t) => ({
      domain: t.domain,
      externalId: t.externalId,
      createdAt: t.createdAt.toISOString(),
    })),
  };
}

// ── Restore ──────────────────────────────────────────────────────────────────

export async function clearWorkouts(ctx: RestoreContext): Promise<void> {
  const workouts = await ctx.tx.workout.deleteMany({
    where: { userId: ctx.ownerId },
  });
  ctx.cleared.workouts = workouts.count;
  // The workout lines of the deletion ledger go with the workouts they
  // guard; the ECG lines belong to the ECG section, which replaces them with
  // the recordings (`restoreAppleHealthTombstones`).
  await ctx.tx.appleHealthTombstone.deleteMany({
    where: { userId: ctx.ownerId, domain: "workout" },
  });
}

/**
 * Replace one domain's lines of the deletion ledger with the file's (a
 * disaster-recovery file carries them; a portable one none, which leaves the
 * domain empty, as its rows are replaced from the file too). Each section
 * calls it for its own domain, so neither wipes what guards the other.
 */
export async function restoreAppleHealthTombstones(
  tx: Prisma.TransactionClient,
  ownerId: string,
  entries: readonly AppleHealthTombstoneBackupEntry[],
  domain: AppleHealthTombstoneDomain,
): Promise<void> {
  await tx.appleHealthTombstone.deleteMany({
    where: { userId: ownerId, domain },
  });
  const lines = entries.filter((t) => t.domain === domain);
  if (lines.length === 0) return;
  await tx.appleHealthTombstone.createMany({
    data: lines.map((t) => ({
      userId: ownerId,
      domain,
      externalId: t.externalId,
      createdAt: new Date(t.createdAt),
    })),
    skipDuplicates: true,
  });
}

export async function restoreWorkouts(ctx: RestoreContext): Promise<void> {
  const { tx, ownerId, payload } = ctx;
  await restoreAppleHealthTombstones(
    tx,
    ownerId,
    payload.appleHealthTombstones,
    "workout",
  );
  if (payload.workouts.length === 0) return;
  await tx.workout.createMany({
    data: payload.workouts.map((workout) => ({
      ...(workout.id ? { id: workout.id } : {}),
      userId: ownerId,
      sportType: workout.sportType,
      startedAt: new Date(workout.startedAt),
      endedAt: new Date(workout.endedAt),
      durationSec: workout.durationSec,
      totalEnergyKcal: workout.totalEnergyKcal ?? null,
      totalDistanceM: workout.totalDistanceM ?? null,
      avgHeartRate: workout.avgHeartRate ?? null,
      maxHeartRate: workout.maxHeartRate ?? null,
      minHeartRate: workout.minHeartRate ?? null,
      stepCount: workout.stepCount ?? null,
      elevationM: workout.elevationM ?? null,
      pauseDurationSec: workout.pauseDurationSec ?? null,
      source: workout.source as never,
      externalId: workout.externalId ?? null,
      externalSourceVersion: workout.externalSourceVersion ?? null,
      ...(workout.metadata == null
        ? {}
        : { metadata: toJson(workout.metadata) }),
      ...(workout.createdAt ? { createdAt: new Date(workout.createdAt) } : {}),
      ...(workout.updatedAt ? { updatedAt: new Date(workout.updatedAt) } : {}),
    })),
  });
}

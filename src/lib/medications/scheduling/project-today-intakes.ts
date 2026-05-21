/**
 * Shared today-window intake projector for the two routes that both
 * need to backfill `MedicationIntakeEvent` rows for daily schedules
 * before reading them:
 *
 *   - `/api/medications/intake?scope=today` (web + iOS Erfassen sheet)
 *   - `/api/dashboard/summary`              (iOS Dashboard tile)
 *
 * Pre-v1.4.41 both routes carried their own copy of the projection +
 * idempotent `createMany` + per-`(med, day)` compliance recompute. The
 * two implementations grew apart twice; this helper folds them into
 * one tested location so future changes (new IntakeSource literal,
 * new schedule cadence, audit metadata) only have to land once.
 *
 * The helper is intentionally side-effect-only:
 *   1. Projects the active schedules through `expandTodayIntakes`.
 *   2. Reads existing rows in the today-window.
 *   3. Inserts the missing rows (`skipDuplicates: true` for the
 *      `(userId, medicationId, scheduledFor, source)` unique index).
 *   4. Fires one compliance-rollup recompute per distinct
 *      `(medicationId, dayKey)` so the rollup matches the new
 *      `scheduled` count before the next read.
 *
 * The caller owns its own typed re-read of `MedicationIntakeEvent`
 * afterwards — the two routes return different projections of those
 * rows, so the helper stays read-shape-neutral.
 *
 * Returns the counts so the caller can surface them on `annotate(...)`.
 */
import { prisma } from "@/lib/db";
import { expandTodayIntakes } from "@/lib/medication-schedule";
import { recomputeMedicationComplianceForEvent } from "@/lib/rollups/medication-compliance-rollups";

export interface ProjectTodayIntakesResult {
  projected: number;
  backfilled: number;
}

export async function projectTodayIntakesAndRecompute(input: {
  userId: string;
  userTz: string;
  todayStart: Date;
  todayEnd: Date;
}): Promise<ProjectTodayIntakesResult> {
  const { userId, userTz, todayStart, todayEnd } = input;

  const activeMedications = await prisma.medication.findMany({
    where: { userId, active: true },
    select: {
      id: true,
      schedules: {
        select: {
          id: true,
          medicationId: true,
          windowStart: true,
          windowEnd: true,
          daysOfWeek: true,
        },
      },
    },
  });

  const projected = expandTodayIntakes(
    activeMedications.flatMap((m) => m.schedules),
    new Date(),
    userTz,
  );

  if (projected.length === 0) {
    return { projected: 0, backfilled: 0 };
  }

  const existing = await prisma.medicationIntakeEvent.findMany({
    where: {
      userId,
      scheduledFor: { gte: todayStart, lt: todayEnd },
    },
    select: { medicationId: true, scheduledFor: true },
  });
  const existingKey = new Set(
    existing.map((e) => `${e.medicationId}|${e.scheduledFor.toISOString()}`),
  );
  const missing = projected.filter(
    (p) => !existingKey.has(`${p.medicationId}|${p.scheduledFor.toISOString()}`),
  );

  if (missing.length === 0) {
    return { projected: projected.length, backfilled: 0 };
  }

  await prisma.medicationIntakeEvent.createMany({
    data: missing.map((m) => ({
      userId,
      medicationId: m.medicationId,
      scheduledFor: m.scheduledFor,
      takenAt: null,
      skipped: false,
      // `REMINDER` is the same source the reminder worker uses to mint
      // RED-phase rows — semantically "the server projected this slot
      // before the user logged anything". The `IntakeSource` enum has
      // no separate `SCHEDULER` literal; reusing REMINDER keeps the
      // doctor-report + analytics filters byte-stable.
      source: "REMINDER",
    })),
    // Paired with the schema-level @@unique([userId, medicationId,
    // scheduledFor, source]). A concurrent dashboard-summary + intake
    // route hit can race a duplicate row in between the existence
    // probe and createMany; the flag tells Postgres to swallow the
    // rejected rows so the request still returns 2xx. The unique
    // constraint is the structural backstop; this is the
    // defense-in-depth.
    skipDuplicates: true,
  });

  // Close the v1.4.39.4 compliance-rollup hook gap: a bulk projection
  // mints fresh `(medicationId, scheduledFor)` rows in PENDING state;
  // without this hook the rollup row stays at its previous
  // `scheduled` count, which inflates compliance % until the user
  // actually logs against the new row. Coalesce by `(medicationId,
  // dayKey)` so we fire one recompute per distinct day-tuple instead
  // of one per row.
  //
  // `Promise.allSettled` keeps the best-effort contract explicit at
  // the call site: the helper swallows internally today, but a
  // future refactor that lets a throw escape would otherwise turn
  // the parent POST into a 5xx.
  const seenDayKeys = new Set<string>();
  const recomputeJobs: Array<Promise<void>> = [];
  for (const m of missing) {
    const key = `${m.medicationId}|${m.scheduledFor.toISOString().slice(0, 10)}`;
    if (seenDayKeys.has(key)) continue;
    seenDayKeys.add(key);
    recomputeJobs.push(
      recomputeMedicationComplianceForEvent({
        userId,
        medicationId: m.medicationId,
        scheduledFor: m.scheduledFor,
        tz: userTz,
      }),
    );
  }
  await Promise.allSettled(recomputeJobs);

  return { projected: projected.length, backfilled: missing.length };
}

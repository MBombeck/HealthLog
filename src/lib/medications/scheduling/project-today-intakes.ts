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
 *   1. Projects the active schedules through the canonical recurrence
 *      engine (`scheduleEmitsInWindow`), minting at `windowStart`.
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
import {
  buildCanonicalSchedule,
  buildRecurrenceContext,
  scheduleEmitsInWindow,
} from "@/lib/medications/scheduling/worker-helpers";
import { localHmAsUtc } from "@/lib/timezone";
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
      startsOn: true,
      endsOn: true,
      oneShot: true,
      createdAt: true,
      schedules: {
        select: {
          id: true,
          medicationId: true,
          windowStart: true,
          windowEnd: true,
          daysOfWeek: true,
          timesOfDay: true,
          reminderGraceMinutes: true,
          rrule: true,
          rollingIntervalDays: true,
          // v1.7.0 — PRN short-circuits to zero slots and CYCLIC gates the
          // inner cadence by an on/off-week phase; both decisions live in
          // the canonical engine, so the projector must select the new
          // columns or every PRN / CYCLIC schedule would project as a
          // plain SCHEDULED row.
          scheduleType: true,
          cyclicOnWeeks: true,
          cyclicOffWeeks: true,
        },
      },
    },
  });

  // v1.6.0 read-flip — gate every "does this schedule emit today?"
  // decision through the canonical recurrence engine (the same path the
  // reminder worker uses). The legacy `expandTodayIntakes` walker read
  // only `daysOfWeek` + `windowStart` and silently skipped
  // `intervalWeeks > 1`, rolling, RRULE, and one-shot cadences — so the
  // dashboard / intake today-tile diverged from what the worker minted
  // for bi-weekly (GLP-1), rolling, and RRULE-only schedules. The
  // `scheduledFor` instant stays anchored to `windowStart` so it remains
  // byte-identical to the worker's RED-phase row and dedupes against the
  // `@@unique([userId, medicationId, scheduledFor, source])` index.
  const now = new Date();
  const projected: Array<{ medicationId: string; scheduledFor: Date }> = [];

  for (const med of activeMedications) {
    if (med.schedules.length === 0) continue;

    // Rolling cadence anchors off the last logged intake. One findFirst
    // per medication, scoped to `takenAt IS NOT NULL` — byte-identical to
    // the reminder worker's baseline (`reminder-worker.ts`), so projector
    // and worker resolve the same next-due instant and never mint
    // divergent `(med, scheduledFor)` rows.
    let lastIntakeAt: Date | null = null;
    if (med.schedules.some((s) => s.rollingIntervalDays !== null)) {
      const lastIntake = await prisma.medicationIntakeEvent.findFirst({
        // v1.7.0 sync — a tombstoned intake is no longer a taken dose, so
        // it must not anchor the rolling-interval next-due computation.
        where: {
          userId,
          medicationId: med.id,
          deletedAt: null,
          takenAt: { not: null },
        },
        orderBy: { takenAt: "desc" },
        select: { takenAt: true },
      });
      lastIntakeAt = lastIntake?.takenAt ?? null;
    }

    const ctx = buildRecurrenceContext({ medication: med, userTz, lastIntakeAt });

    for (const schedule of med.schedules) {
      const canonical = buildCanonicalSchedule(schedule);
      if (!scheduleEmitsInWindow(canonical, ctx, todayStart, todayEnd)) {
        continue;
      }
      const [h, m] = schedule.windowStart.split(":").map(Number);
      if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
      projected.push({
        medicationId: schedule.medicationId,
        scheduledFor: localHmAsUtc(now, userTz, h, m),
      });
    }
  }

  if (projected.length === 0) {
    return { projected: 0, backfilled: 0 };
  }

  const existing = await prisma.medicationIntakeEvent.findMany({
    where: {
      userId,
      scheduledFor: { gte: todayStart, lt: todayEnd },
    },
    // v1.7.0 sync — intentionally NO `deletedAt: null` filter here. A
    // tombstoned row still occupies its `(userId, medicationId,
    // scheduledFor, source)` unique slot, so the backfill must treat it
    // as present to avoid a P2002 collision when minting REMINDER rows.
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

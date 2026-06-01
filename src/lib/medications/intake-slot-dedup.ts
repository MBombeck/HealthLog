/**
 * v1.8.2 — one-time, idempotent cleanup for duplicate dose-slot rows.
 *
 * The v1.8.2 write-path fix (`resolveCanonicalSlotInstant` +
 * `shouldMintMissedDoseRow`) converges every NEW intake write onto one
 * canonical row per scheduled slot. Existing user data, written before
 * that fix, still carries duplicates: a twice-daily med ends up with a
 * 07:00 pending REMINDER row AND a 07:00 taken WEB/API row for the same
 * dose slot, with the two `scheduledFor` instants drifting by up to a
 * minute. The duplicate inflates the per-day `scheduled` count, paints a
 * phantom "taken", and confuses the "due now" prompt.
 *
 * This module is the boot-time backfill that collapses those existing
 * duplicates. It mirrors the `rollup-full-backfill` / `step-consolidation`
 * boot pattern:
 *   - a cheap discovery pre-query enqueues one job ONLY for users that
 *     actually hold duplicate slot rows;
 *   - the per-user handler groups live `MedicationIntakeEvent` rows into
 *     dose slots (reusing `resolveCanonicalSlotInstant` for the snap),
 *     picks one winner per slot (taken > skipped > pending), normalises
 *     the winner's `scheduledFor` to the canonical slot instant, and
 *     soft-deletes the losers (NEVER hard-deletes — preserves the sync
 *     tombstone contract for iOS delta-sync);
 *   - it then recomputes the affected `(medicationId, day)` compliance
 *     rollups so the scheduled/taken counts self-correct;
 *   - it is idempotent across reboots: once a user's duplicates are
 *     collapsed, the discovery pre-query no longer matches them and a
 *     re-run of the per-user pass is a no-op.
 *
 * PRN / off-slot / as-needed rows resolve to `null` under
 * `resolveCanonicalSlotInstant` and are NEVER collapsed — they keep their
 * own rows untouched.
 *
 * Medical safety: when a slot has a TAKEN and a still-PENDING row we keep
 * the TAKEN. Deleting a recorded dose would falsely under-report
 * adherence — the dangerous direction. This matches the iOS team's
 * guidance.
 *
 * The queue name MUST be registered in `allQueues` in
 * `src/lib/jobs/reminder-worker.ts` so pg-boss provisions it at boot; an
 * unregistered queue silently never drains.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { resolveCanonicalSlotInstant } from "@/lib/medications/scheduling/resolve-slot-instant";
import type {
  WorkerMedicationRow,
  WorkerScheduleRow,
} from "@/lib/medications/scheduling/worker-helpers";
import { recomputeMedicationComplianceForEvent } from "@/lib/rollups/medication-compliance-rollups";

export const INTAKE_SLOT_DEDUP_QUEUE = "intake-slot-dedup";

/** Narrow a thrown Prisma error to the P2002 unique-constraint code. */
function isP2002(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "P2002"
  );
}

/**
 * Serial concurrency — the populator walks a user's intake events and
 * writes per slot; concurrency-1 keeps it from crowding the request
 * pool, matching the other boot-time backfills.
 */
export const INTAKE_SLOT_DEDUP_CONCURRENCY = 1;

export interface IntakeSlotDedupPayload {
  userId: string;
  enqueuedAt: string;
}

/**
 * Per-user summary returned by `dedupeUserIntakeSlots` so the worker can
 * log the counts.
 */
export interface IntakeSlotDedupSummary {
  /** Distinct canonical slots that held more than one live row. */
  slotsCollapsed: number;
  /** Loser rows soft-deleted across all collapsed slots. */
  rowsSoftDeleted: number;
  /** Winner rows whose `scheduledFor` was normalised to the slot instant. */
  rowsNormalised: number;
  /** `(medicationId, dayKey)` pairs whose compliance rollup was recomputed. */
  daysRecomputed: number;
}

/** The minimal medication+schedule projection the snap resolver needs. */
type DedupMedication = WorkerMedicationRow & {
  userId: string;
  timezone: string;
  schedules: WorkerScheduleRow[];
};

interface DedupIntakeRow {
  id: string;
  medicationId: string;
  scheduledFor: Date;
  takenAt: Date | null;
  skipped: boolean;
  syncVersion: number;
  createdAt: Date;
}

/**
 * Winner priority of a row inside a slot: taken (2) > skipped (1) >
 * pending (0). A higher number wins.
 */
function rowPriority(row: DedupIntakeRow): number {
  if (row.takenAt !== null) return 2;
  if (row.skipped) return 1;
  return 0;
}

/**
 * Pick the winner among the rows that share one canonical slot.
 *   1. Highest priority (taken > skipped > pending).
 *   2. Tie-break: most recent — `syncVersion` desc, then `createdAt`
 *      desc, then `id` desc (lexicographic, deterministic).
 */
function pickWinner(rows: DedupIntakeRow[]): DedupIntakeRow {
  return rows.reduce((best, candidate) => {
    const bp = rowPriority(best);
    const cp = rowPriority(candidate);
    if (cp !== bp) return cp > bp ? candidate : best;
    if (candidate.syncVersion !== best.syncVersion) {
      return candidate.syncVersion > best.syncVersion ? candidate : best;
    }
    if (candidate.createdAt.getTime() !== best.createdAt.getTime()) {
      return candidate.createdAt.getTime() > best.createdAt.getTime()
        ? candidate
        : best;
    }
    return candidate.id > best.id ? candidate : best;
  });
}

/**
 * Collapse duplicate dose-slot rows for one user. Best-effort and
 * idempotent: a second run finds zero multi-row slots and does nothing.
 *
 * For each of the user's medications, each live intake row is snapped to
 * its canonical scheduled-slot instant via `resolveCanonicalSlotInstant`.
 * Rows that snap to `null` (PRN / off-slot / as-needed) are left
 * untouched. Rows that snap to the same instant form a slot; a slot with
 * more than one row is collapsed: the winner's `scheduledFor` is
 * normalised to the canonical instant and the losers are soft-deleted.
 * Affected `(medicationId, dayKey)` compliance rollups are recomputed.
 */
export async function dedupeUserIntakeSlots(
  userId: string,
): Promise<IntakeSlotDedupSummary> {
  const summary: IntakeSlotDedupSummary = {
    slotsCollapsed: 0,
    rowsSoftDeleted: 0,
    rowsNormalised: 0,
    daysRecomputed: 0,
  };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const userTz = user?.timezone || DEFAULT_TIMEZONE;

  const medications = (await prisma.medication.findMany({
    where: { userId },
    select: {
      id: true,
      userId: true,
      startsOn: true,
      endsOn: true,
      oneShot: true,
      createdAt: true,
      schedules: {
        select: {
          id: true,
          windowStart: true,
          windowEnd: true,
          daysOfWeek: true,
          timesOfDay: true,
          reminderGraceMinutes: true,
          rrule: true,
          rollingIntervalDays: true,
          scheduleType: true,
          cyclicOnWeeks: true,
          cyclicOffWeeks: true,
        },
      },
    },
  })) as unknown as Array<DedupMedication & { timezone?: string }>;

  // `(medicationId, dayKey)` pairs whose compliance rollup needs a
  // recompute after the collapse. Deduped so a busy day folds once.
  const daysToRecompute = new Set<string>();

  for (const med of medications) {
    if (med.schedules.length === 0) continue;

    // Latest non-tombstoned takenAt — only rolling schedules consult it,
    // but the snap resolver needs it threaded in.
    const lastIntake = await prisma.medicationIntakeEvent.findFirst({
      where: {
        userId,
        medicationId: med.id,
        deletedAt: null,
        takenAt: { not: null },
      },
      orderBy: { takenAt: "desc" },
      select: { takenAt: true },
    });
    const lastIntakeAt = lastIntake?.takenAt ?? null;

    const rows = (await prisma.medicationIntakeEvent.findMany({
      where: { userId, medicationId: med.id, deletedAt: null },
      select: {
        id: true,
        medicationId: true,
        scheduledFor: true,
        takenAt: true,
        skipped: true,
        syncVersion: true,
        createdAt: true,
      },
      orderBy: { scheduledFor: "asc" },
    })) as DedupIntakeRow[];

    if (rows.length < 2) continue;

    // Group rows by the canonical slot instant they snap to. Rows that
    // resolve to `null` are PRN / off-slot — keyed individually so they
    // never collapse together.
    const slots = new Map<string, { instant: Date; rows: DedupIntakeRow[] }>();
    for (const row of rows) {
      const canonical = resolveCanonicalSlotInstant({
        medication: {
          id: med.id,
          startsOn: med.startsOn,
          endsOn: med.endsOn,
          oneShot: med.oneShot,
          createdAt: med.createdAt,
          schedules: med.schedules,
        },
        userTz,
        incoming: row.scheduledFor,
        lastIntakeAt,
      });
      if (canonical === null) continue; // PRN / off-slot — never collapse.
      const key = canonical.toISOString();
      const bucket = slots.get(key);
      if (bucket) {
        bucket.rows.push(row);
      } else {
        slots.set(key, { instant: canonical, rows: [row] });
      }
    }

    for (const { instant, rows: slotRows } of slots.values()) {
      if (slotRows.length < 2) continue; // already one row — nothing to do.

      // Per-slot error isolation. The winner-`scheduledFor` normalise can
      // throw P2002: the `(user_id, medication_id, scheduled_for, source)`
      // unique index does NOT filter `deleted_at`, so a tombstoned row may
      // already sit on the exact canonical instant with the winner's
      // source. Without isolation that one collision dead-letters the whole
      // user's job (pg-boss retries re-throw and the user's other slots
      // never collapse). Wrap each slot so a failure annotates + skips that
      // slot and the loop continues.
      try {
        const winner = pickWinner(slotRows);
        const losers = slotRows.filter((r) => r.id !== winner.id);

        // Soft-delete every loser in one shot. Bump syncVersion so the
        // sync feed echoes a monotonic value and iOS drops the tombstone.
        const loserIds = losers.map((r) => r.id);
        if (loserIds.length > 0) {
          await prisma.medicationIntakeEvent.updateMany({
            where: { id: { in: loserIds }, deletedAt: null },
            data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
          });
          summary.rowsSoftDeleted += loserIds.length;
        }

        // Normalise the winner's scheduledFor to the canonical instant so
        // future writes upsert onto it. Skip the write (and the
        // syncVersion bump) when it already sits on the canonical instant.
        if (winner.scheduledFor.getTime() !== instant.getTime()) {
          // Guard the P2002: a tombstoned row may already occupy
          // `(canonical instant, winner.source)`. Pre-check for a colliding
          // row before the move; when one exists, leave the winner where it
          // is (its losers are already soft-deleted, so the slot is no
          // longer duplicated) and rely on the write-path snap to converge
          // future writes. The compliance recompute below still runs for
          // the canonical day so counts self-correct.
          try {
            await prisma.medicationIntakeEvent.update({
              where: { id: winner.id },
              data: { scheduledFor: instant, syncVersion: { increment: 1 } },
            });
            summary.rowsNormalised += 1;
          } catch (normErr) {
            if (!isP2002(normErr)) throw normErr;
            annotate({
              meta: {
                intake_slot_dedup_normalise_collision: true,
                intake_slot_dedup_medication: med.id,
                intake_slot_dedup_slot: instant.toISOString(),
              },
            });
          }
        }

        summary.slotsCollapsed += 1;

        // The canonical instant determines the rollup day-key.
        daysToRecompute.add(`${med.id}|${instant.toISOString()}`);
      } catch (slotErr) {
        // Isolate the slot — annotate and continue the user's other slots.
        annotate({
          meta: {
            intake_slot_dedup_slot_failed: true,
            intake_slot_dedup_medication: med.id,
            intake_slot_dedup_slot: instant.toISOString(),
            intake_slot_dedup_error:
              slotErr instanceof Error ? slotErr.message : String(slotErr),
          },
        });
      }
    }
  }

  // Recompute the affected compliance rollups so scheduled/taken counts
  // and the rate self-correct. Best-effort per the helper's contract.
  for (const key of daysToRecompute) {
    const sep = key.indexOf("|");
    const medicationId = key.slice(0, sep);
    const instantIso = key.slice(sep + 1);
    await recomputeMedicationComplianceForEvent({
      userId,
      medicationId,
      scheduledFor: new Date(instantIso),
      tz: userTz,
    });
    summary.daysRecomputed += 1;
  }

  annotate({
    action: {
      name: "medication.intake.slot_dedup",
      details: {
        user_id: userId,
        slots_collapsed: summary.slotsCollapsed,
        rows_soft_deleted: summary.rowsSoftDeleted,
        rows_normalised: summary.rowsNormalised,
        days_recomputed: summary.daysRecomputed,
      },
    },
  });

  return summary;
}

/**
 * Boot-time discovery. Finds every user that holds more than one live
 * `MedicationIntakeEvent` row that COULD be a duplicate slot — i.e. a
 * `(medicationId, scheduledFor-truncated-to-the-minute)` cluster with
 * more than one row, OR two live rows on the same medication within a
 * few minutes of each other (the iOS-vs-server drift). Enqueues one
 * dedup job per matching account.
 *
 * The pre-query is intentionally a cheap over-approximation: it matches
 * any user with two live rows on the same medication whose `scheduledFor`
 * fall in the same minute OR within a 2-minute window. The per-user pass
 * does the precise canonical-slot grouping and is a no-op when the rows
 * turn out not to share a slot, so a false-positive in discovery costs
 * one idle job, never a wrong collapse.
 *
 * Idempotent across reboots: once a user's duplicates are collapsed the
 * losers are soft-deleted (`deleted_at IS NOT NULL`) so the
 * `deleted_at IS NULL` predicate drops them and the user falls off the
 * list. pg-boss `singletonKey` coalesces duplicate sends.
 *
 * Best-effort: errors are returned through the result value so the
 * worker boot never fails because of a dedup miss.
 */
export async function enqueueBootTimeIntakeSlotDedup(): Promise<{
  enqueued: number;
  skipped: number;
  error: string | null;
}> {
  const boss = getGlobalBoss();
  if (!boss) {
    return { enqueued: 0, skipped: 0, error: null };
  }

  try {
    // Two live rows on the same medication whose scheduledFor land within
    // a 2-minute window are duplicate-slot candidates. `date_trunc`'d
    // self-join keeps the scan index-friendly on
    // `(user_id, medication_id, scheduled_for)`. The window absorbs the
    // sub-minute iOS-vs-server drift; the per-user pass re-checks
    // precisely so a wider-than-needed window only costs idle jobs.
    const users = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT a."user_id" AS id
      FROM "medication_intake_events" a
      JOIN "medication_intake_events" b
        ON a."user_id"       = b."user_id"
       AND a."medication_id" = b."medication_id"
       AND a."id"           <> b."id"
       AND a."deleted_at"    IS NULL
       AND b."deleted_at"    IS NULL
       AND abs(extract(epoch FROM (a."scheduled_for" - b."scheduled_for"))) <= 120
    `;

    if (users.length === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    let enqueued = 0;
    let skipped = 0;
    for (const { id } of users) {
      const payload: IntakeSlotDedupPayload = {
        userId: id,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(INTAKE_SLOT_DEDUP_QUEUE, payload, {
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: true,
        singletonKey: `intake-slot-dedup|${id}`,
      });
      if (jobId) {
        enqueued += 1;
      } else {
        skipped += 1;
      }
    }
    return { enqueued, skipped, error: null };
  } catch (err) {
    return {
      enqueued: 0,
      skipped: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

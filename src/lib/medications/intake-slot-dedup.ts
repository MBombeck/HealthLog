/**
 * v1.8.2 — idempotent cleanup for duplicate dose-slot rows.
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
 * This module is the backfill that collapses those existing duplicates.
 * Discovery runs at worker boot AND on a daily cron tick (v1.15.19 — a
 * duplicate created between deploys must not wait for the next reboot).
 * It mirrors the `rollup-full-backfill` / `step-consolidation` boot
 * pattern:
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
import {
  MEDICATION_WINDOW_SELECT,
  medicationWindow,
} from "@/lib/medications/course-window";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { restoreForIntake } from "@/lib/medications/inventory/consumption";
import { isP2002 } from "@/lib/prisma-errors";
import { annotate } from "@/lib/logging/context";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { resolveCanonicalSlotInstant } from "@/lib/medications/scheduling/resolve-slot-instant";
import {
  buildMedicationDayBands,
  type AttributeIntakeMedication,
} from "@/lib/medications/scheduling/attribute-intake";
import type { ScheduleRevisionLike } from "@/lib/medications/scheduling/schedule-eras";
import type {
  WorkerMedicationRow,
  WorkerScheduleRow,
} from "@/lib/medications/scheduling/worker-helpers";
import { refreshDoseSlot } from "@/lib/medications/dose-day-refresh";

export const INTAKE_SLOT_DEDUP_QUEUE = "intake-slot-dedup";

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
  /** v1.16.9 — archived eras so the band convergence honours old times. */
  scheduleRevisions: ScheduleRevisionLike[];
};

interface DedupIntakeRow {
  id: string;
  medicationId: string;
  scheduledFor: Date;
  takenAt: Date | null;
  skipped: boolean;
  syncVersion: number;
  createdAt: Date;
  /**
   * v1.16.0 — slot-binding provenance; USER_PIN = the user fixed the
   * attribution by hand (pin onto a slot OR released as deliberately
   * ad-hoc). Such a row never joins a snap cluster.
   */
  attributionSource: string;
  /**
   * v1.16.9 — write origin. The ad-hoc→pending band convergence only
   * touches API / REMINDER rows (external ingest + the Telegram webhook,
   * the two paths that historically bare-created `scheduledFor =
   * takenAt`); a WEB or IMPORT ad-hoc row is a deliberate user shape.
   */
  source: string;
  /**
   * v1.16.10 — inventory consumption stamp. A stamped LOSER row refunds
   * its consumed units before the tombstone (the winner keeps its own
   * stamp untouched), so collapsing a duplicate never strands stock.
   */
  inventoryConsumption: unknown;
}

/**
 * Winner priority of a row inside a slot: pinned take (3) > taken (2) >
 * skipped (1) > pending (0). A higher number wins. The USER_PIN rung
 * (v1.16.0) is defensive here — USER_PIN rows never enter a cluster in
 * the first place (see the exclusion in `dedupeUserIntakeSlots`) — but it
 * keeps this rank the mirror of the repair script's `rowRank`
 * (`scripts/repair-intake-anomalies.ts`), where exact-instant groups DO
 * contain pins and the pin is the dose of record for its slot.
 */
function rowPriority(row: DedupIntakeRow): number {
  if (row.takenAt !== null) {
    return row.attributionSource === "USER_PIN" ? 3 : 2;
  }
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
      ...MEDICATION_WINDOW_SELECT,
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
          // v1.16.9 — the band convergence honours the persisted per-dose
          // windows (the same lever the write path + read ledger consume).
          doseWindows: true,
        },
      },
      // v1.16.9 — archived eras: an old ad-hoc row converges against the
      // schedule that was live at its takenAt, not today's times.
      scheduleRevisions: {
        orderBy: [{ validFrom: "asc" }, { id: "asc" }],
        select: {
          id: true,
          validFrom: true,
          validUntil: true,
          payload: true,
          supersededByRevisionId: true,
        },
      },
    },
  })) as unknown as Array<DedupMedication & { timezone?: string }>;

  // `(medicationId, dayKey)` pairs whose compliance rollup needs a
  // recompute after the collapse. Deduped so a busy day folds once.
  const daysToRecompute = new Set<string>();

  // One ordered read for the user's whole medication set, grouped in memory
  // by `medicationId`, rather than a `findFirst` and a `findMany` per
  // medication (2N round-trips). The per-med `lastIntakeAt` comes from the
  // same rows. The order ends on the id, so each slice holds its rows in the
  // slot order the snap and heal passes need, the same on every run.
  const medIds = medications
    .filter((m) => m.schedules.length > 0)
    .map((m) => m.id);

  const rowsByMedication = new Map<string, DedupIntakeRow[]>();
  const lastIntakeAtByMedication = new Map<string, Date | null>();
  if (medIds.length > 0) {
    const allRows = (await prisma.medicationIntakeEvent.findMany({
      where: { userId, medicationId: { in: medIds }, deletedAt: null },
      select: {
        id: true,
        medicationId: true,
        scheduledFor: true,
        takenAt: true,
        skipped: true,
        syncVersion: true,
        createdAt: true,
        // v1.16.0 — pin-awareness: a USER_PIN row never joins a cluster.
        attributionSource: true,
        // v1.16.9 — write origin for the ad-hoc→pending convergence gate.
        source: true,
        // v1.16.10 — stamped losers refund their consumption on collapse.
        inventoryConsumption: true,
      },
      // `medicationId` first so the per-med slices are contiguous, then the
      // `scheduledFor asc` the loop relies on.
      orderBy: [
        { medicationId: "asc" },
        { scheduledFor: "asc" },
        { id: "asc" },
      ],
    })) as DedupIntakeRow[];

    for (const row of allRows) {
      const list = rowsByMedication.get(row.medicationId);
      if (list) {
        list.push(row);
      } else {
        rowsByMedication.set(row.medicationId, [row]);
      }
      // Latest non-tombstoned takenAt per medication — the same value the
      // per-med `findFirst({ takenAt: { not: null }, orderBy: desc })`
      // returned. Only rolling schedules consult it, but the snap resolver
      // needs it threaded in.
      if (row.takenAt !== null) {
        const prev = lastIntakeAtByMedication.get(row.medicationId) ?? null;
        if (prev === null || row.takenAt.getTime() > prev.getTime()) {
          lastIntakeAtByMedication.set(row.medicationId, row.takenAt);
        }
      }
    }
  }

  for (const med of medications) {
    if (med.schedules.length === 0) continue;

    const lastIntakeAt = lastIntakeAtByMedication.get(med.id) ?? null;
    const rows = rowsByMedication.get(med.id) ?? [];

    if (rows.length < 2) continue;

    // v1.16.9 — heal pass FIRST: converge ad-hoc actioned API/REMINDER
    // rows onto the pending row of the slot whose minted band contains
    // the takenAt. The legacy snap pass below only reaches a ±half-window
    // tolerance, so an 18-minute-early API ingest beside its pending
    // 09:00 REMINDER row never clustered — the production damage this
    // backfill exists to repair. The pass mutates `rows` in place
    // (tombstoned pending rows removed, the winner's `scheduledFor`
    // normalised) so the snap pass below operates on the healed state.
    await convergeAdhocRowsOntoPendingSlots({
      med,
      rows,
      userTz,
      lastIntakeAt,
      summary,
      daysToRecompute,
    });

    if (rows.length < 2) continue;

    // Group rows by the canonical slot instant they snap to. Rows that
    // resolve to `null` are PRN / off-slot — keyed individually so they
    // never collapse together.
    const slots = new Map<string, { instant: Date; rows: DedupIntakeRow[] }>();
    for (const row of rows) {
      // v1.16.0 — a USER_PIN row (attribution fixed by the user: pinned
      // onto a slot, or released as deliberately ad-hoc with
      // `scheduledFor === takenAt`) never joins a slot cluster. The
      // canonical-instant resolver still uses the legacy ± half-window
      // tolerance, WIDER than the band model, so snapping would silently
      // revert the user's binding decision (and, when the slot row is
      // also a take, soft-delete one of two real dose records). Keyed on
      // the persisted provenance — NOT on the `scheduledFor === takenAt`
      // shape, which since v1.15.19 every AUTO standalone insert shares:
      // those legitimate drift duplicates (an iOS row +60 s beside the
      // server pending row) MUST stay collapsible. Declining to collapse
      // a pin is always safe: the row simply keeps its own anchor.
      if (row.attributionSource === "USER_PIN") continue;
      const canonical = resolveCanonicalSlotInstant({
        medication: {
          id: med.id,
          ...medicationWindow(med),
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

        // v1.16.10 — a stamped loser (a real taken row losing to a pin)
        // refunds its consumed units before the tombstone; unstamped
        // losers (pending / skipped / pre-stamp rows) skip the round
        // trip. The winner keeps its own stamp untouched.
        for (const loser of losers) {
          if (loser.inventoryConsumption !== null) {
            await restoreForIntake({
              client: prisma,
              userId,
              eventId: loser.id,
            });
          }
        }

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
    await refreshDoseSlot({
      userId,
      medicationId,
      scheduledFor: new Date(instantIso),
      tz: userTz,
    });
    summary.daysRecomputed += 1;
  }

  // v1.16.1 — a collapse changed the rows the cached compliance / intake /
  // summary payloads were built on; drop this user's server caches so the
  // next read reflects the corrected slots instead of waiting out the TTL.
  // Process-local like every server cache: in the default single-container
  // deploy the worker shares the web process, so the eviction reaches the
  // serving instance; a split web/worker deployment falls back to the TTL
  // bound (see `server-cache.ts`).
  if (
    summary.slotsCollapsed > 0 ||
    summary.rowsSoftDeleted > 0 ||
    summary.rowsNormalised > 0
  ) {
    invalidateUserMedications(userId);
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
 * v1.16.9 — converge ad-hoc actioned rows onto their slot's pending row.
 *
 * The healed shape: an external-API or Telegram take historically
 * bare-created `scheduledFor = takenAt`, leaving the worker-minted
 * pending REMINDER row open. The pending row later auto-missed, so the
 * ledger showed an ad-hoc take PLUS a missed slot for one real dose.
 * The write paths converge since v1.16.9; this pass repairs the rows
 * already written.
 *
 * Deliberately conservative — a pair converges ONLY when:
 *   - the actioned row is ad-hoc shaped (`scheduledFor === takenAt`,
 *     taken, not skipped), source API or REMINDER, and not USER_PIN;
 *   - exactly ONE minted band contains the takenAt (the bands are
 *     disjoint by construction, but a zero- or ambiguous-match take is
 *     left alone);
 *   - the band's anchor carries exactly ONE live row and that row is
 *     unactioned (no takenAt, not skipped — a cron auto-miss flag does
 *     not count as an action: the take proves the miss wrong).
 *
 * The actioned row is the dose of record: its `scheduledFor` normalises
 * to the band anchor and the pending row is tombstoned (soft-deleted,
 * syncVersion bumped) per the canonical pattern. `rows` is mutated in
 * place so the caller's snap pass sees the healed state.
 */
async function convergeAdhocRowsOntoPendingSlots(input: {
  med: DedupMedication;
  rows: DedupIntakeRow[];
  userTz: string;
  lastIntakeAt: Date | null;
  summary: IntakeSlotDedupSummary;
  daysToRecompute: Set<string>;
}): Promise<void> {
  const { med, rows, userTz, lastIntakeAt, summary, daysToRecompute } = input;

  const isRolling = med.schedules.some((s) => s.rollingIntervalDays !== null);

  const adhocCandidates = rows.filter(
    (r) =>
      r.takenAt !== null &&
      !r.skipped &&
      r.scheduledFor.getTime() === r.takenAt.getTime() &&
      r.attributionSource !== "USER_PIN" &&
      (r.source === "API" || r.source === "REMINDER"),
  );
  if (adhocCandidates.length === 0) return;

  const medication: AttributeIntakeMedication = {
    id: med.id,
    ...medicationWindow(med),
    oneShot: med.oneShot,
    createdAt: med.createdAt,
    schedules: med.schedules,
    scheduleRevisions: med.scheduleRevisions ?? [],
  };

  for (const adhoc of adhocCandidates) {
    try {
      const takenAt = adhoc.takenAt as Date;
      // Rolling cadences anchor their retrospective grid AT each intake;
      // build the instants from the rows already in memory, EXCLUDING the
      // candidate itself (its own ad-hoc anchor must not mint the band it
      // is judged against).
      const intakeInstants = isRolling
        ? rows
            .filter(
              (r) =>
                r.id !== adhoc.id &&
                r.takenAt !== null &&
                !r.skipped &&
                r.takenAt.getTime() <= takenAt.getTime(),
            )
            .map((r) => r.takenAt as Date)
            .sort((a, b) => a.getTime() - b.getTime())
        : undefined;

      const { bands, hasExpectedSlots } = buildMedicationDayBands({
        medication,
        userTz,
        around: takenAt,
        lastIntakeAt,
        intakeInstants,
        now: takenAt,
      });
      if (!hasExpectedSlots) continue;

      const t = takenAt.getTime();
      // The lower bound honours the bounded early grace (`earlyStart`):
      // an explicit window that starts AT the dose time ("09:00–10:00")
      // must still converge an 08:42 take — the same reach the write-path
      // attribution credits. Bands without the field keep the strict
      // on-time start.
      const matching = bands.filter(
        (b) =>
          t >= (b.earlyStart ?? b.onTimeStart).getTime() &&
          t <= b.overdueEnd.getTime(),
      );
      if (matching.length !== 1) continue; // zero or ambiguous — leave alone.
      const anchor = matching[0].at;
      if (anchor.getTime() === adhoc.scheduledFor.getTime()) continue; // same instant — the snap pass owns it.

      const anchorRows = rows.filter(
        (r) =>
          r.id !== adhoc.id && r.scheduledFor.getTime() === anchor.getTime(),
      );
      if (anchorRows.length !== 1) continue; // empty or double-slot — leave alone.
      const pending = anchorRows[0];
      if (pending.takenAt !== null || pending.skipped) continue; // already served.

      // Tombstone the pending row; the take is the dose of record.
      await prisma.medicationIntakeEvent.updateMany({
        where: { id: pending.id, deletedAt: null },
        data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
      });
      summary.rowsSoftDeleted += 1;

      const adhocDayInstant = adhoc.scheduledFor;
      // Normalise the take onto the canonical anchor. Same P2002 guard as
      // the snap pass: a tombstoned row may already occupy
      // `(anchor, source)`; when it does the take keeps its own anchor —
      // the pending row is already gone, so the slot no longer double-counts.
      try {
        await prisma.medicationIntakeEvent.update({
          where: { id: adhoc.id },
          data: { scheduledFor: anchor, syncVersion: { increment: 1 } },
        });
        summary.rowsNormalised += 1;
        adhoc.scheduledFor = anchor;
      } catch (normErr) {
        if (!isP2002(normErr)) throw normErr;
        annotate({
          meta: {
            intake_slot_dedup_converge_collision: true,
            intake_slot_dedup_medication: med.id,
            intake_slot_dedup_slot: anchor.toISOString(),
          },
        });
      }

      summary.slotsCollapsed += 1;

      // Both local days can differ for day-scale bands — recompute each.
      daysToRecompute.add(`${med.id}|${anchor.toISOString()}`);
      daysToRecompute.add(`${med.id}|${adhocDayInstant.toISOString()}`);

      // Mutate the in-memory rows so the snap pass sees the healed state.
      const pendingIdx = rows.findIndex((r) => r.id === pending.id);
      if (pendingIdx >= 0) rows.splice(pendingIdx, 1);
    } catch (pairErr) {
      annotate({
        meta: {
          intake_slot_dedup_converge_failed: true,
          intake_slot_dedup_medication: med.id,
          intake_slot_dedup_error:
            pairErr instanceof Error ? pairErr.message : String(pairErr),
        },
      });
    }
  }
}

/**
 * Discovery pass — runs at worker boot and on the daily cron tick (the
 * cron payload omits `userId`; the worker handler dispatches here). Finds
 * every user that holds more than one live
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
    //
    // v1.16.9 — second arm: the ad-hoc→pending heal pattern. An actioned
    // ad-hoc row (`scheduled_for = taken_at`) beside an unactioned row on
    // the same medication can sit up to the widest band reach apart
    // (weekly on-time 1d + overdue 4d ≈ 5 days; 475200 s adds half a day
    // of slack) — far outside the 2-minute drift arm, which is why the
    // 18-minute API/REMINDER pairs were never enqueued. The per-user pass
    // re-checks by exact band membership, so the wide arm only costs idle
    // jobs.
    const users = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT a."user_id" AS id
      FROM "medication_intake_events" a
      JOIN "medication_intake_events" b
        ON a."user_id"       = b."user_id"
       AND a."medication_id" = b."medication_id"
       AND a."id"           <> b."id"
       AND a."deleted_at"    IS NULL
       AND b."deleted_at"    IS NULL
       AND (
         abs(extract(epoch FROM (a."scheduled_for" - b."scheduled_for"))) <= 120
         OR (
           a."taken_at" IS NOT NULL
           AND a."scheduled_for" = a."taken_at"
           AND a."skipped" = false
           AND a."source" IN ('API', 'REMINDER')
           AND b."taken_at" IS NULL
           AND b."skipped" = false
           AND abs(extract(epoch FROM (a."scheduled_for" - b."scheduled_for"))) <= 475200
         )
       )
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

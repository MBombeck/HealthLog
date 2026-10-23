/**
 * The row a dose posted to `POST /api/medications/{id}/intake` lands on: the
 * replay and dedup answers, the canonical slot write, the convergence probe
 * onto a row already on the named instant, or the standalone insert.
 */
import type { MedicationIntakeEvent } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import type { InjectionSiteKey } from "@/lib/medications/injection-sites";
import {
  applyCanonicalSlotWrite,
  mayConvergeOntoSuppliedSlot,
  type ApplyCanonicalSlotWriteResult,
} from "@/lib/medications/scheduling/slot-upsert";
import type { AttributionSource } from "./attribution";

type IntakeRow = MedicationIntakeEvent | ApplyCanonicalSlotWriteResult["row"];

export interface IntakeWrite {
  userId: string;
  medicationId: string;
  canonicalSlot: Date | null;
  attributionSource: AttributionSource | undefined;
  scheduledFor: Date | undefined;
  skipped: boolean;
  idempotencyKey: string | undefined;
  resolvedTakenAt: Date | null;
  incomingScheduledFor: Date;
  intakeSource: "API" | "WEB";
  isDelegated: boolean;
  resolvedInjectionSite: InjectionSiteKey | null;
  resolvedDoseTaken: string | null;
}

export type IntakeWriteResult =
  | { kind: "existing"; row: MedicationIntakeEvent }
  | { kind: "outcome_change_refused" }
  | { kind: "written"; event: IntakeRow; consumedTransition: boolean };

/**
 * Idempotency check (explicit key or server-side dedup window). The row a
 * replay or a double-log answers with, or null when the dose is new.
 */
export async function findReplayedIntake(
  write: IntakeWrite,
): Promise<MedicationIntakeEvent | null> {
  const { userId, medicationId: id, idempotencyKey, skipped } = write;
  if (idempotencyKey) {
    const existing = await prisma.medicationIntakeEvent.findFirst({
      where: {
        idempotencyKey,
        userId,
        medicationId: id,
      },
    });
    if (existing) {
      return existing;
    }
  } else if (!write.canonicalSlot) {
    // Unscheduled / PRN only — the slot upsert handles dedup for
    // scheduled doses by collapsing onto the canonical slot row.
    // Server-side dedup: prevent double-logging within 60 seconds.
    const recentDuplicate = await prisma.medicationIntakeEvent.findFirst({
      where: {
        userId,
        medicationId: id,
        skipped,
        createdAt: { gte: new Date(Date.now() - 60_000) },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (recentDuplicate) {
      return recentDuplicate;
    }
  }
  return null;
}

/**
 * Converge onto the one slot row through the shared upsert: H1 deterministic
 * selection, C2 no-downgrade guard, and a C1 race-safe create that re-finds +
 * updates on a P2002 collision rather than 500-ing or duplicating.
 */
async function writeOntoSlot(
  write: IntakeWrite,
  canonicalSlot: Date,
): Promise<IntakeWriteResult> {
  const { userId, medicationId: id, skipped } = write;
  // The per-med route only ever carries an explicit user gesture:
  // `resolvedTakenAt` is `now()` for any non-skip POST (there is no
  // "mark pending" write on this route), so a non-skip is an explicit
  // taken and a `skipped:true` body is an explicit skip. Neither is a
  // pending projection echo, so the no-downgrade guard never trips here —
  // it is the bulk/sync route that replays pending echoes. The flags are
  // threaded through so the shared upsert applies last-write-wins.
  const isExplicitTaken = !skipped;
  const isExplicitSkip = skipped === true;
  const applied = await applyCanonicalSlotWrite({
    client: prisma,
    userId,
    medicationId: id,
    canonicalSlot,
    takenAt: write.resolvedTakenAt,
    skipped,
    isExplicitTaken,
    isExplicitSkip,
    idempotencyKey: write.idempotencyKey ?? null,
    createSource: write.intakeSource,
    refuseOutcomeChange: write.isDelegated,
    // Resolved + validated site (null unless a tracking-on
    // injection taken write supplied an allowed site).
    injectionSite: write.resolvedInjectionSite,
    attributionSource: write.attributionSource,
    // Per-intake dose override (null unless a taken write
    // carried one).
    doseTaken: write.resolvedDoseTaken,
  });
  if (applied.outcomeChangeRefused) return { kind: "outcome_change_refused" };
  // Reset the snooze when a dose is actually recorded (not on a
  // no-downgrade no-op, which left the prior taken row untouched).
  if (!skipped && !applied.noDowngradeNoOp) {
    await prisma.medication.update({
      where: { id },
      data: { snoozedUntil: null },
    });
  }
  return {
    kind: "written",
    event: applied.row,
    consumedTransition: applied.consumedTransition,
  };
}

/**
 * Genuinely standalone. Anchor a taken write on the intake instant — the
 * documented ad-hoc contract (`scheduledFor = takenAt`) — so an unresolvable
 * client anchor can never park a live row exactly on a slot instant a pending
 * REMINDER row is minted for later. A skip without a slot keeps the incoming
 * instant (it has no takenAt).
 */
async function insertStandalone(write: IntakeWrite): Promise<IntakeRow> {
  const {
    userId,
    medicationId: id,
    skipped,
    resolvedTakenAt,
    resolvedInjectionSite,
    resolvedDoseTaken,
  } = write;
  const [event] = await prisma.$transaction([
    prisma.medicationIntakeEvent.create({
      data: {
        userId,
        medicationId: id,
        scheduledFor: resolvedTakenAt ?? write.incomingScheduledFor,
        takenAt: resolvedTakenAt,
        skipped,
        source: write.intakeSource,
        idempotencyKey: write.idempotencyKey ?? null,
        // Site only on a resolved taken-injection write.
        ...(resolvedInjectionSite !== null && {
          injectionSite: resolvedInjectionSite,
        }),
        // Dose override only on a taken write carrying one.
        ...(resolvedDoseTaken !== null && {
          doseTaken: resolvedDoseTaken,
        }),
      },
    }),
    // Reset snooze when medication is taken
    ...(!skipped
      ? [
          prisma.medication.update({
            where: { id },
            data: { snoozedUntil: null },
          }),
        ]
      : []),
  ]);
  return event;
}

/** Write the dose; the caller already answered a replay. */
export async function writeIntake(
  write: IntakeWrite,
): Promise<IntakeWriteResult> {
  const { userId, medicationId: id, skipped, scheduledFor } = write;
  if (write.canonicalSlot) {
    // Scheduled dose — converge onto the one canonical slot row regardless
    // of `source` (the pending REMINDER row, or any prior row for this
    // slot).
    return writeOntoSlot(write, write.canonicalSlot);
  }
  // Unscheduled / PRN / off-slot. When the client named an explicit
  // `scheduledFor`, converge source-agnostically onto any live row that
  // already sits on that instant (e.g. the pending REMINDER row the
  // worker minted on a slot the band attribution did not claim) before
  // inserting. Without the probe the insert lands a second live row for
  // the same slot that differs only by `source` — the partial unique
  // index carries `source` and cannot catch it — inflating the
  // compliance rollup's scheduled count. A defaulted anchor (takenAt /
  // now) never names a slot, so the probe is skipped on that hot path.
  //
  // Dose-safety guard: a TAKEN write must not converge onto a slot whose
  // anchor is in the future relative to the take. The card advances its
  // display-due to the evening slot once the morning slot's catch-up
  // window lapses, so a late-morning "Genommen" posts the evening slot as
  // `scheduledFor`; band attribution already rejected the take, and the
  // probe must not re-bind it forward onto the evening pending row (a
  // late-morning dose silently consuming the 21:00 slot). It records
  // standalone (ad-hoc) instead.
  const existingSlotRow =
    scheduledFor !== undefined &&
    mayConvergeOntoSuppliedSlot({
      skipped,
      takenAt: write.resolvedTakenAt,
      suppliedSlot: write.incomingScheduledFor,
    })
      ? await prisma.medicationIntakeEvent.findFirst({
          where: {
            userId,
            medicationId: id,
            scheduledFor: write.incomingScheduledFor,
            deletedAt: null,
          },
          select: { id: true },
        })
      : null;
  if (existingSlotRow) {
    return writeOntoSlot(write, write.incomingScheduledFor);
  }
  // For the unscheduled/PRN branch a non-skip write always records a fresh
  // dose, so it consumes when not skipped.
  return {
    kind: "written",
    event: await insertStandalone(write),
    consumedTransition: !skipped,
  };
}

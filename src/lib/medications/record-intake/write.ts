/**
 * The row a dose posted to `POST /api/medications/{id}/intake` lands on: the
 * replay and dedup answers, the canonical slot write, the convergence probe
 * onto a row already on the named instant, or the standalone insert.
 */
import type { MedicationIntakeEvent } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  createAdHocIntake,
  slotOfStoredRow,
} from "@/lib/medications/ad-hoc-intake";
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

/**
 * `slotInstant` is the slot the answered row is on, null for a row on no
 * slot (an ad-hoc take, an extra dose): what the route answers as
 * `slotInstant`.
 */
export type IntakeWriteResult =
  | { kind: "existing"; row: MedicationIntakeEvent; slotInstant: Date | null }
  | { kind: "outcome_change_refused" }
  | {
      kind: "alreadyTaken";
      row: MedicationIntakeEvent;
      slotInstant: Date | null;
    }
  | {
      kind: "written";
      event: IntakeRow;
      consumedTransition: boolean;
      slotInstant: Date | null;
    };

/** How close to a recorded dose a second one is the same tap: a minute. */
const REPEAT_TAP_MS = 60_000;

type ReplayedIntake = Extract<
  IntakeWriteResult,
  { kind: "existing" } | { kind: "alreadyTaken" }
>;

/**
 * The dose a write repeats, when it is one: the row its idempotency key
 * already wrote, or, for a dose without a key that no slot answers, the same
 * dose recorded within a minute of it (a double tap, a retried request).
 *
 * The repeat is judged on what a row records, never on when the row was
 * created: a live take of the same kind with its take time within a minute,
 * or a live skip with its anchor within a minute. A row created a moment ago
 * that records nothing (a pending slot the same request or the page load
 * projected), a take undone a moment ago, and a take logged for two hours
 * earlier are not this dose, and answering with one of them stored nothing
 * behind a success. An extra dose repeats only an extra dose, a plain take
 * only a plain take, and either only a row on its own instant (no slot).
 *
 * A key replay answers the row as it stands; a repeated take answers
 * `alreadyTaken`, like a repeat the slot write or the new-take rule finds.
 */
export async function findReplayedIntake(
  write: IntakeWrite,
): Promise<ReplayedIntake | null> {
  const { userId, medicationId: id, idempotencyKey, skipped } = write;
  if (idempotencyKey) {
    const existing = await prisma.medicationIntakeEvent.findFirst({
      where: {
        idempotencyKey,
        userId,
        medicationId: id,
      },
    });
    return existing
      ? {
          kind: "existing",
          row: existing,
          slotInstant: slotOfStoredRow(existing),
        }
      : null;
  }
  // A scheduled dose converges onto its slot row, whose write answers its
  // own repeats under the slot lock.
  if (write.canonicalSlot) return null;
  if (skipped) {
    const at = write.incomingScheduledFor.getTime();
    const skip = await prisma.medicationIntakeEvent.findFirst({
      where: {
        userId,
        medicationId: id,
        deletedAt: null,
        skipped: true,
        scheduledFor: {
          gte: new Date(at - REPEAT_TAP_MS),
          lte: new Date(at + REPEAT_TAP_MS),
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    // Found only for a skip no slot answers: on no slot either.
    return skip ? { kind: "existing", row: skip, slotInstant: null } : null;
  }
  const takenAt = write.resolvedTakenAt;
  if (takenAt === null) return null;
  const extra = write.attributionSource === "USER_PIN";
  const candidates = await prisma.medicationIntakeEvent.findMany({
    where: {
      userId,
      medicationId: id,
      deletedAt: null,
      skipped: false,
      takenAt: {
        gte: new Date(takenAt.getTime() - REPEAT_TAP_MS),
        lte: new Date(takenAt.getTime() + REPEAT_TAP_MS),
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const repeat = candidates.find(
    (row) =>
      row.takenAt !== null &&
      row.scheduledFor.getTime() === row.takenAt.getTime() &&
      (row.attributionSource === "USER_PIN") === extra,
  );
  // A row on its own instant, by the filter above: on no slot.
  return repeat
    ? { kind: "alreadyTaken", row: repeat, slotInstant: null }
    : null;
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
    takenVia: write.intakeSource === "WEB" ? "WEB" : "APP",
  });
  if (applied.outcomeChangeRefused) return { kind: "outcome_change_refused" };
  const slotInstant = canonicalSlot;
  if (applied.alreadyTaken) {
    return { kind: "alreadyTaken", row: applied.row, slotInstant };
  }
  // A no-op (a replayed decision) wrote nothing: no audit row, no push, no
  // guardian notice, no stock movement.
  if (applied.noDowngradeNoOp) {
    return { kind: "existing", row: applied.row, slotInstant };
  }
  // Reset the snooze when a dose is actually recorded.
  if (!skipped) {
    await prisma.medication.update({
      where: { id },
      data: { snoozedUntil: null },
    });
  }
  return {
    kind: "written",
    event: applied.row,
    consumedTransition: applied.consumedTransition,
    slotInstant,
  };
}

/**
 * Genuinely standalone. Anchor a taken write on the intake instant — the
 * documented ad-hoc contract (`scheduledFor = takenAt`) — so an unresolvable
 * client anchor can never park a live row exactly on a slot instant a pending
 * REMINDER row is minted for later. A skip without a slot keeps the incoming
 * instant (it has no takenAt). On the exact instant of a slot row it moves to
 * the next free millisecond (`ad-hoc-intake.ts`).
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
  return prisma.$transaction(async (tx) => {
    const event = await createAdHocIntake(tx, {
      userId,
      medicationId: id,
      scheduledFor: resolvedTakenAt ?? write.incomingScheduledFor,
      takenAt: resolvedTakenAt,
      skipped,
      source: write.intakeSource,
      ...(resolvedTakenAt !== null && {
        takenVia: write.intakeSource === "WEB" ? "WEB" : "APP",
      }),
      idempotencyKey: write.idempotencyKey ?? null,
      // An extra dose is a released pin: USER_PIN on its own instant, so no
      // reader binds it to a band.
      ...(write.attributionSource === "USER_PIN" && {
        attributionSource: "USER_PIN",
      }),
      // Site only on a resolved taken-injection write.
      ...(resolvedInjectionSite !== null && {
        injectionSite: resolvedInjectionSite,
      }),
      // Dose override only on a taken write carrying one.
      ...(resolvedDoseTaken !== null && {
        doseTaken: resolvedDoseTaken,
      }),
    });
    // Reset snooze when medication is taken
    if (!skipped) {
      await tx.medication.update({
        where: { id },
        data: { snoozedUntil: null },
      });
    }
    return event;
  });
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
    slotInstant: null,
  };
}

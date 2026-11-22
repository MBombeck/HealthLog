/**
 * Every scheduled dose of the record's medications over a window, each with
 * its resolved state: `GET /api/medications/resolved-slots`.
 *
 * One read for what a client otherwise asks medication by medication through
 * `GET /api/medications/{id}/dose-history`. The slots and their states come
 * from the same dose ledger (`./ledger.ts`) and the same resolver
 * (`./resolve.ts`) the history, the today list and the medication card read,
 * over the window the caller names, so the three never disagree.
 *
 * Statements: the medications with their schedules, eras and courses, the
 * ledgers' two batched intake reads, and one read of the takes' origin,
 * whatever the number of medications.
 */
import { prisma } from "@/lib/db";
import { TRACKED_INTAKE_WHERE } from "@/lib/medications/intake-tracking";
import { DOSE_LEDGER_MEDICATION_INCLUDE, loadDoseLedgers } from "./ledger";
import {
  resolveLedgerSlot,
  serializeResolvedDose,
  wireDoseState,
  type DoseTakenVia,
} from "./resolve";

/** The longest window one request may name. */
export const RESOLVED_SLOTS_MAX_DAYS = 14;

/** One slot on the wire. */
function slotWire(
  resolved: NonNullable<ReturnType<typeof resolveLedgerSlot>>,
  intake: { id?: string | null } | null,
  pinned: boolean,
) {
  const s = serializeResolvedDose(resolved);
  return {
    slotInstant: s.slotInstant,
    ...wireDoseState(resolved.state),
    dueAt: s.dueAt,
    overdueSince: s.overdueSince,
    missedAfter: s.missedAfter,
    lateTakeCounts: s.lateTakeCounts,
    takenAt: s.takenAt,
    takenVia: s.takenVia,
    intakeId: intake?.id ?? null,
    pinned,
  };
}

export async function readResolvedSlots(input: {
  userId: string;
  userTz: string;
  from: Date;
  to: Date;
  now: Date;
}) {
  const { userId, userTz, from, to, now } = input;
  // The medications that can be due: active, scheduled, intake tracked.
  const medications = await prisma.medication.findMany({
    where: { userId, active: true, asNeeded: false, ...TRACKED_INTAKE_WHERE },
    include: DOSE_LEDGER_MEDICATION_INCLUDE,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const ledgers = await loadDoseLedgers({
    userId,
    userTz,
    now,
    ledgers: medications.map((medication) => ({ medication, from, to })),
  });

  const inWindow = (at: Date) =>
    at.getTime() >= from.getTime() && at.getTime() <= to.getTime();
  // Where each take on a slot came from, in one read.
  const takeIds = [...ledgers.values()].flatMap((ledger) =>
    ledger.rows.flatMap((row) =>
      row.kind === "slot" && inWindow(row.at) && row.intake?.takenAt
        ? row.intake.id
          ? [row.intake.id]
          : []
        : [],
    ),
  );
  const takenVia = new Map<string, DoseTakenVia | null>(
    takeIds.length === 0
      ? []
      : (
          await prisma.medicationIntakeEvent.findMany({
            where: { id: { in: takeIds }, userId },
            select: { id: true, takenVia: true },
          })
        ).map((r) => [r.id, r.takenVia]),
  );

  return medications.map((medication) => {
    const ledger = ledgers.get(medication.id);
    const slots = (ledger?.rows ?? []).flatMap((row) => {
      if (row.kind !== "slot" || !inWindow(row.at)) return [];
      const id = row.intake?.id;
      const resolved = resolveLedgerSlot(
        row,
        now,
        id ? (takenVia.get(id) ?? null) : null,
      );
      return resolved
        ? [slotWire(resolved, row.intake, row.pinned === true)]
        : [];
    });
    return {
      medicationId: medication.id,
      family: ledger?.family ?? "none",
      slots,
    };
  });
}

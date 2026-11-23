/**
 * The resolved state of each intake row of a window, by row id, read from
 * every affected medication's dose ledger. A row the ledger does not place on
 * a slot (an ad-hoc take, a placeholder outside every band) gets no entry.
 */
import { prisma } from "@/lib/db";
import {
  DOSE_LEDGER_MEDICATION_INCLUDE,
  loadDoseLedgers,
  type DoseLedgerMedication,
} from "./ledger";
import {
  resolveLedgerSlot,
  type DoseTakenVia,
  type ResolvedDose,
} from "./resolve";

/** How far back the ledger reads so a rolling cadence finds its anchor. */
const LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;

/** The medications of `ids` with what their ledgers need. */
export function readLedgerMedications(
  userId: string,
  ids: readonly string[],
): Promise<DoseLedgerMedication[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return prisma.medication.findMany({
    where: { id: { in: [...new Set(ids)] }, userId },
    include: DOSE_LEDGER_MEDICATION_INCLUDE,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export async function resolveDosesByRow(input: {
  userId: string;
  userTz: string;
  /** The medications, or their ids to read them by. */
  medications: readonly string[] | readonly DoseLedgerMedication[];
  /** The rows' takes, for `takenVia` on the resolved state. */
  takenViaByRow: ReadonlyMap<string, DoseTakenVia | null>;
  from: Date;
  to: Date;
  now: Date;
}): Promise<Map<string, ResolvedDose>> {
  const out = new Map<string, ResolvedDose>();
  if (input.medications.length === 0) return out;
  const medications =
    typeof input.medications[0] === "string"
      ? await readLedgerMedications(
          input.userId,
          input.medications as readonly string[],
        )
      : (input.medications as readonly DoseLedgerMedication[]);
  // Every medication's ledger from one batched read: the query count does
  // not grow with the number of medications.
  const ledgers = await loadDoseLedgers({
    userId: input.userId,
    userTz: input.userTz,
    now: input.now,
    ledgers: medications.map((medication) => ({
      medication,
      from: new Date(input.from.getTime() - LOOKBACK_MS),
      to: input.to,
    })),
  });
  for (const ledger of ledgers.values()) {
    for (const row of ledger.rows) {
      const id = row.intake?.id;
      const resolved = resolveLedgerSlot(
        row,
        input.now,
        id ? (input.takenViaByRow.get(id) ?? null) : null,
      );
      if (id && resolved) out.set(id, resolved);
    }
  }
  return out;
}

/**
 * The resolved state of each medication's dose at `at` (its next due dose),
 * by medication id. A medication with no slot at that instant gets no entry.
 */
export async function resolveDosesAt(input: {
  userId: string;
  userTz: string;
  at: ReadonlyMap<string, Date>;
  now: Date;
}): Promise<Map<string, ResolvedDose>> {
  const out = new Map<string, ResolvedDose>();
  const ids = [...input.at.keys()];
  if (ids.length === 0) return out;
  const medications = await prisma.medication.findMany({
    where: { id: { in: ids }, userId: input.userId },
    include: DOSE_LEDGER_MEDICATION_INCLUDE,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const windows = medications.flatMap((medication) => {
    const at = input.at.get(medication.id);
    if (!at) return [];
    return [
      {
        medication,
        at,
        from: new Date(
          Math.min(at.getTime(), input.now.getTime()) - LOOKBACK_MS,
        ),
        to: new Date(Math.max(at.getTime(), input.now.getTime())),
      },
    ];
  });
  const ledgers = await loadDoseLedgers({
    userId: input.userId,
    userTz: input.userTz,
    now: input.now,
    ledgers: windows,
  });
  for (const { medication, at } of windows) {
    const row = ledgers
      .get(medication.id)
      ?.rows.find((r) => r.kind === "slot" && r.at.getTime() === at.getTime());
    const resolved = row ? resolveLedgerSlot(row, input.now) : null;
    if (resolved) out.set(medication.id, resolved);
  }
  return out;
}

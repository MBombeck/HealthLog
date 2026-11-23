/**
 * The one insert for a dose no slot answers: an ad-hoc take, an extra dose, a
 * skip that found no slot.
 *
 * Such a row is anchored on its own instant (`scheduledFor = takenAt`, the
 * marker every reader uses to tell an ad-hoc row from a slot row). Since 0515
 * one live row holds an instant per medication, whoever wrote it, so an
 * ad-hoc dose recorded on the exact millisecond of a slot (a minute-precise
 * time picker on the 08:00 dose, an Apple Health event on the hour) collided
 * with that slot's row: 500 on the per-medication route, `duplicate` without
 * an id in bulk, a rollback and the same collision again on every Telegram
 * redelivery. The row moves forward to the first free millisecond instead,
 * both columns together, so the ad-hoc marker still holds and the slot keeps
 * its own row. A millisecond is below anything a reader shows.
 *
 * The free instant is probed before the insert, which also works inside an
 * interactive transaction, where a failed insert would abort the transaction.
 * Outside one, a writer that took the instant between the probe and the
 * insert is answered by probing again.
 *
 * `medication-ad-hoc-insert-guard.test.ts` holds every intake insert outside
 * the slot writers to this helper.
 */
import type { MedicationIntakeEvent, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { isP2002 } from "@/lib/prisma-errors";

type Client = Prisma.TransactionClient | typeof prisma;

type AdHocIntakeData = Omit<
  Prisma.MedicationIntakeEventUncheckedCreateInput,
  "scheduledFor" | "takenAt"
> & {
  userId: string;
  medicationId: string;
  scheduledFor: Date;
  takenAt: Date | null;
};

/**
 * The slot a stored row is on, read off the row alone: none for a row on its
 * own instant (the ad-hoc marker, `scheduledFor = takenAt`), its
 * `scheduledFor` otherwise. For a row the caller did not just write; a
 * writer knows the slot it wrote onto.
 */
export function slotOfStoredRow(row: {
  scheduledFor: Date;
  takenAt: Date | null;
}): Date | null {
  return row.takenAt?.getTime() === row.scheduledFor.getTime()
    ? null
    : row.scheduledFor;
}

/** How far an ad-hoc row may move off its instant: a second. */
const MAX_SHIFT_MS = 1_000;
/** How often a race outside a transaction is probed again. */
const MAX_ATTEMPTS = 3;

/** The first instant at or after `at` no live row of the medication holds. */
async function freeInstant(
  client: Client,
  data: AdHocIntakeData,
): Promise<number> {
  const at = data.scheduledFor.getTime();
  const held = await client.medicationIntakeEvent.findMany({
    where: {
      userId: data.userId,
      medicationId: data.medicationId,
      deletedAt: null,
      scheduledFor: { gte: new Date(at), lt: new Date(at + MAX_SHIFT_MS) },
    },
    select: { scheduledFor: true },
  });
  const taken = new Set(held.map((r) => r.scheduledFor.getTime()));
  let free = at;
  while (taken.has(free)) free += 1;
  if (free >= at + MAX_SHIFT_MS) {
    throw new Error("No free instant for an ad-hoc intake within a second");
  }
  return free;
}

function atInstant(data: AdHocIntakeData, instant: number) {
  const shift = instant - data.scheduledFor.getTime();
  return {
    ...data,
    scheduledFor: new Date(instant),
    // The take moves with its anchor only while the two are one instant.
    takenAt:
      data.takenAt !== null &&
      data.takenAt.getTime() === data.scheduledFor.getTime()
        ? new Date(data.takenAt.getTime() + shift)
        : data.takenAt,
  };
}

/**
 * Insert the ad-hoc row on its own instant, or the next free millisecond.
 * Any other unique conflict (an idempotency key, an external id) is the
 * caller's to answer and is thrown unchanged.
 */
export async function createAdHocIntake(
  client: Client,
  data: AdHocIntakeData,
): Promise<MedicationIntakeEvent> {
  const inTransaction = client !== prisma;
  for (let attempt = 1; ; attempt += 1) {
    const instant = await freeInstant(client, data);
    try {
      return await client.medicationIntakeEvent.create({
        data: atInstant(data, instant),
      });
    } catch (err) {
      if (inTransaction || !isP2002(err) || attempt >= MAX_ATTEMPTS) throw err;
      // Retry only when a row took the instant meanwhile; any other unique
      // conflict finds the same instant free again and is thrown.
      if ((await freeInstant(client, data)) === instant) throw err;
    }
  }
}

/**
 * The live row an external dose record (`externalId`, an Apple Health dose
 * event) naming `instant` may converge onto: the slot's row, never a row that
 * records another external dose. Two dose events logged for the same minute
 * are two doses; converging the second onto the first overwrote it last-write-
 * wins, and the first existed nowhere until the next sync posted it again.
 */
export async function findRowForExternalDoseAt(input: {
  userId: string;
  medicationId: string;
  instant: Date;
  externalId: string | null;
}): Promise<{ id: string } | null> {
  const rows = await prisma.medicationIntakeEvent.findMany({
    where: {
      userId: input.userId,
      medicationId: input.medicationId,
      scheduledFor: input.instant,
      deletedAt: null,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, takenAt: true, externalId: true },
  });
  const row = rows.find(
    (r) =>
      input.externalId === null ||
      r.takenAt === null ||
      r.externalId === null ||
      r.externalId === input.externalId,
  );
  return row ? { id: row.id } : null;
}

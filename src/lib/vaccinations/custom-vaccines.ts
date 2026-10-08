/**
 * What the custom-vaccine routes share (v1.42, #1005): the columns they
 * publish, the name-clash probe and the removal.
 */
import type { Prisma } from "@/generated/prisma/client";

/** The columns a definition is published with. */
export const CUSTOM_VACCINE_SELECT = {
  id: true,
  name: true,
  components: true,
  typicalSeriesDoses: true,
  boosterIntervalMonths: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.CustomVaccineSelect;

/**
 * A live definition on the record whose name equals `name` ignoring case,
 * other than `exceptId`. "Dukoral" and "dukoral" are one product to the
 * person reading the picker, even though the unique index tells them apart.
 */
export async function findLiveNameClash(
  tx: Prisma.TransactionClient,
  userId: string,
  name: string,
  exceptId?: string,
): Promise<boolean> {
  const clash = await tx.customVaccine.findFirst({
    where: {
      userId,
      deletedAt: null,
      name: { equals: name, mode: "insensitive" },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  return clash !== null;
}

/**
 * Remove a definition and let go of every dose that named it.
 *
 * The definition is tombstoned; the doses are not touched beyond the link.
 * A dose that carried no wording of its own takes the definition's name as
 * its `vaccineName` first, so it keeps a name — the same thing the foreign
 * key's `ON DELETE SET NULL` promises for a hard delete, done by hand because
 * a tombstone does not fire it. Runs in the caller's transaction so the name
 * and the unlink land together. Returns how many doses were unlinked.
 */
export async function removeCustomVaccine(
  tx: Prisma.TransactionClient,
  userId: string,
  definition: { id: string; name: string },
): Promise<number> {
  await tx.vaccinationRecord.updateMany({
    where: { userId, customVaccineId: definition.id, vaccineName: null },
    data: { vaccineName: definition.name },
  });
  const unlinked = await tx.vaccinationRecord.updateMany({
    where: { userId, customVaccineId: definition.id },
    data: { customVaccineId: null },
  });
  await tx.customVaccine.update({
    where: { id: definition.id },
    data: { deletedAt: new Date() },
  });
  return unlinked.count;
}

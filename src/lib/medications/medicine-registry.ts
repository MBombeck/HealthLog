/**
 * The person's medicine registry (#1430), as the server reads it.
 *
 * The column is NULL until it is settled. `settleMedicineRegistry` derives the
 * starting value once (`deriveMedicineRegistry`) and stores it, guarded on the
 * column still being NULL, so two concurrent reads settle it to the same value
 * and a choice made in between is never overwritten. From then on the stored
 * value is the answer and a change of language or zone does not move it.
 *
 * `resolveMedicineRegistry` is the read-only form for every other reader: the
 * stored value, or the value the next settle will store.
 */
import { prisma } from "@/lib/db";
import {
  isMedicineRegistryChoice,
  type MedicineRegistryChoice,
} from "@/lib/medications/leaflet-registries";
import { deriveMedicineRegistry } from "@/lib/medications/medicine-registry-default";

export interface MedicineRegistrySource {
  id: string;
  medicineRegistry: string | null;
  locale: string | null;
  timezone: string | null;
}

/** The stored choice, or the starting value it will be settled to. */
export function resolveMedicineRegistry(
  user: Omit<MedicineRegistrySource, "id">,
): MedicineRegistryChoice {
  if (isMedicineRegistryChoice(user.medicineRegistry)) {
    return user.medicineRegistry;
  }
  return deriveMedicineRegistry(user);
}

/**
 * Resolve, and store the derived value when the column is still unsettled.
 * The write never fails the read: a lost race or a database hiccup leaves the
 * column NULL and the next read tries again with the same answer.
 */
export async function settleMedicineRegistry(
  user: MedicineRegistrySource,
): Promise<MedicineRegistryChoice> {
  const resolved = resolveMedicineRegistry(user);
  if (user.medicineRegistry === null) {
    await prisma.user
      .updateMany({
        where: { id: user.id, medicineRegistry: null },
        data: { medicineRegistry: resolved },
      })
      .catch(() => undefined);
  }
  return resolved;
}

/**
 * An automatic take is a placeholder, not a recorded dose.
 *
 * The auto-take pass fills a slot nobody answered with a take at the slot
 * time (`autoRecorded`, `takenVia: AUTO`) and takes its stock. Only a take a
 * person or a device recorded holds the slot against a second take
 * (`alreadyTaken`); an automatic one does not. A real take on it replaces it
 * with its own time and origin and takes no stock again; a skip corrects it,
 * and the stock the pass took comes back here. Both clear the label, in the
 * slot write (`slot-upsert.ts`).
 */
import type {
  MedicationIntakeEvent,
  PrismaClient,
} from "@/generated/prisma/client";
import { restoreForIntake } from "@/lib/medications/inventory/consumption";

/** The client the slot write runs on; the inventory is there in every caller. */
export type SlotWriteClient = Pick<
  PrismaClient,
  "medication" | "medicationIntakeEvent"
> &
  Partial<Pick<PrismaClient, "medicationInventoryItem">>;

// One rule for "this row holds a take": `./holds-take`.
export { holdsTake } from "./holds-take";

/**
 * Give back the stock of an automatic take a skip corrects. The refund is
 * keyed on the take's stamp and claims it, so a caller that refunds a skip
 * itself (the bulk route) cannot refund twice. A client without the
 * inventory (a unit test's partial mock) has no stock to give back.
 */
export async function refundCorrectedAutoTake(
  client: SlotWriteClient,
  existing: MedicationIntakeEvent,
): Promise<void> {
  const taken = existing.takenAt !== null && !existing.skipped;
  if (!taken || !existing.autoRecorded || !client.medicationInventoryItem) {
    return;
  }
  await restoreForIntake({
    client: client as SlotWriteClient &
      Pick<PrismaClient, "medicationInventoryItem">,
    userId: existing.userId,
    eventId: existing.id,
  });
}

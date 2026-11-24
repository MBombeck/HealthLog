/**
 * The plain fields of a visit edit: what the body names, sealed where the
 * column is ciphertext. The relations (practitioner, series, reminder) need
 * the transaction and stay with the route.
 */
import type { Prisma } from "@/generated/prisma/client";

import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import type { EncounterUpdate } from "@/lib/validations/encounters";

export function encounterFieldUpdate(
  entry: EncounterUpdate,
  nextOccurredAt: Date,
): Prisma.EncounterUpdateInput {
  const data: Prisma.EncounterUpdateInput = {};
  if (entry.occurredAt !== undefined) data.occurredAt = nextOccurredAt;
  if (entry.status !== undefined) data.status = entry.status;
  if (entry.kind !== undefined) data.kind = entry.kind;
  if (entry.reason !== undefined) {
    data.reasonEncrypted = entry.reason ? encryptToBytes(entry.reason) : null;
  }
  if (entry.outcome !== undefined) {
    data.outcomeEncrypted = entry.outcome
      ? encryptToBytes(entry.outcome)
      : null;
  }
  if (entry.bodySite !== undefined) {
    data.bodySiteEncrypted = entry.bodySite?.trim()
      ? encryptToBytes(entry.bodySite.trim())
      : null;
  }
  if (entry.laterality !== undefined) data.laterality = entry.laterality;
  return data;
}

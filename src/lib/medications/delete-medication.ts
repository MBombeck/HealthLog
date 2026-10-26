/**
 * Delete one medication: `DELETE /api/medications/{id}`.
 *
 * The route authenticates (the caller's own account) and runs the ownership
 * guard; the token revocation, the delete, its audit row and its tails run
 * here, in the order they always ran.
 */
import { prisma } from "@/lib/db";
import {
  enqueueSupplementNutrientRecompute,
  medicationHasComposition,
} from "@/lib/medications/ingredients/recompute-job";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { deleteMedicationCategory } from "@/lib/medication-category";

/**
 * The name the audit row carries, read after the ownership guard passed.
 * Null for the route's 404.
 */
export async function findMedicationForDelete(
  id: string,
): Promise<{ name: string } | null> {
  return prisma.medication.findUnique({
    where: { id },
    select: { name: true },
  });
}

export async function deleteMedication(input: {
  userId: string;
  id: string;
  existing: { name: string };
  ipAddress: string | null;
}): Promise<void> {
  const { userId, id, existing } = input;

  // Revoke API tokens scoped to this medication
  const medicationScope = `medication:${id}:ingest`;
  await prisma.apiToken.updateMany({
    where: {
      userId,
      revoked: false,
      permissions: { has: medicationScope },
    },
    data: { revoked: true },
  });

  // Whether its doses counted toward the micronutrients, read
  // before the delete cascades the composition away.
  const hadComposition = await medicationHasComposition(userId, id);

  await deleteMedicationCategory(id);
  await prisma.medication.delete({ where: { id } });

  await auditLog("medication.delete", {
    userId,
    ipAddress: input.ipAddress,
    details: { medicationId: id, name: existing.name },
  });

  annotate({
    action: {
      name: "medication.delete",
      entity_type: "medication",
      entity_id: id,
    },
  });

  // Bust per-user medications + compliance + achievement
  // caches so the next read reflects the deletion.
  invalidateUserMedications(userId, { evict: true });

  // Its doses are gone with it, so the days they counted on are recomputed.
  if (hadComposition) await enqueueSupplementNutrientRecompute(userId);
}

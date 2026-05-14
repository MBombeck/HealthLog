/**
 * v1.4.25 W21 Fix-N — shared medication-route ownership guard.
 *
 * Eleven medication sub-routes (titration, side-effects, inventory,
 * cadence, intake, compliance, phase-config, api-endpoint, glp1, plus
 * the inventory `[itemId]` sub-route owned by Fix-M) all duplicated the
 * same fetch-medication-then-compare-userId block, often with subtly
 * different `select` clauses or response shapes. Hoisting the guard to
 * one helper keeps the privacy contract honest — the 404 leak shape
 * (we always return "Medication not found" so an attacker can't
 * distinguish "row exists but isn't yours" from "row doesn't exist")
 * lives in exactly one place.
 *
 * Callers compose it the same way the inline guards used to:
 *
 *   const guard = await assertMedicationOwnership(id, user.id);
 *   if (guard) return guard;
 *
 * The helper accepts an optional Prisma client so test mocks can pass
 * a stubbed `findUnique`. In production callers omit the third arg and
 * pull `prisma` from the lazy `@/lib/db` import internally.
 */

import { apiError } from "@/lib/api-response";

interface MedicationOwnershipPrisma {
  medication: {
    findUnique: (args: {
      where: { id: string };
      select: { id: true; userId: true };
    }) => Promise<{ id: string; userId: string } | null>;
  };
}

/**
 * Returns `null` when the medication exists AND belongs to the caller.
 * Returns a 404 `Response` otherwise — the route handler should return
 * it directly without modification.
 */
export async function assertMedicationOwnership(
  medicationId: string,
  userId: string,
  prismaClient?: MedicationOwnershipPrisma,
): Promise<Response | null> {
  const client = prismaClient ?? (await loadPrisma());
  const med = await client.medication.findUnique({
    where: { id: medicationId },
    select: { id: true, userId: true },
  });
  if (!med || med.userId !== userId) {
    return apiError("Medication not found", 404);
  }
  return null;
}

async function loadPrisma(): Promise<MedicationOwnershipPrisma> {
  // Lazy import so test files that stub `@/lib/db` at the module level
  // see their stub instead of the real Prisma client. Matches the
  // pattern the route handlers themselves use.
  const { prisma } = await import("@/lib/db");
  return prisma as unknown as MedicationOwnershipPrisma;
}

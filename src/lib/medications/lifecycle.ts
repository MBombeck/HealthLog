/**
 * v1.5.0 — one-shot medication lifecycle reconciliation.
 *
 * A `oneShot:true` medication carries at most one intake. The audit
 * surfaced that the auto-deactivate hook on POST was one-way: logging
 * the dose flipped `active:false`, but DELETE / PUT on the intake event
 * never re-evaluated the medication state. A user who logged the flu
 * shot then undid the log was left with a permanently-inactive
 * medication that dropped off every list / dashboard / worker tick.
 *
 * `reconcileOneShotState` is the single helper every intake-mutation
 * path tails. It re-reads the most recent live (non-skipped, non-null
 * takenAt) intake for the medication; if one exists the medication is
 * inactive, otherwise it is reactivated. The Prisma `update` is keyed
 * on `oneShot:true` so the call is a no-op for every other medication
 * shape — callers do not need to branch.
 *
 * Pure best-effort. A failure to reconcile must not block the intake
 * mutation itself; callers wrap accordingly.
 */

import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";

interface ReconcilePrisma {
  medication: {
    findUnique: (args: {
      where: { id: string };
      select: { oneShot: true; active: true };
    }) => Promise<{ oneShot: boolean; active: boolean } | null>;
    updateMany: (args: {
      where: { id: string; userId: string; oneShot: true };
      data: { active: boolean };
    }) => Promise<{ count: number }>;
  };
  medicationIntakeEvent: {
    findFirst: (args: {
      where: {
        userId: string;
        medicationId: string;
        deletedAt: null;
        skipped: false;
        takenAt: { not: null };
      };
      orderBy: { takenAt: "desc" };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
  };
}

export type ReconcileOneShotAction = "activate" | "deactivate" | "noop";

/**
 * Re-evaluate the `active` flag for a one-shot medication after an
 * intake mutation. Idempotent. Returns the action taken so the caller
 * can surface it in observability if it cares.
 *
 *   - "deactivate": medication had a live intake AND was active → flipped to false.
 *   - "activate":   medication had no live intake AND was inactive → flipped to true.
 *   - "noop":       state already matched OR medication is not one-shot.
 */
export async function reconcileOneShotState(
  prismaClient: ReconcilePrisma,
  medicationId: string,
  userId: string,
): Promise<ReconcileOneShotAction> {
  const med = await prismaClient.medication.findUnique({
    where: { id: medicationId },
    select: { oneShot: true, active: true },
  });
  if (!med || !med.oneShot) return "noop";

  const liveIntake = await prismaClient.medicationIntakeEvent.findFirst({
    where: {
      userId,
      medicationId,
      // v1.7.0 sync — a tombstoned intake no longer counts as the logged
      // one-shot dose, so soft-deleting it reactivates the medication.
      deletedAt: null,
      skipped: false,
      takenAt: { not: null },
    },
    orderBy: { takenAt: "desc" },
    select: { id: true },
  });

  const shouldBeActive = liveIntake === null;

  if (med.active === shouldBeActive) {
    annotate({
      action: { name: "medication.oneShot.reconciled" },
      meta: { medication_id: medicationId, action: "noop" },
    });
    return "noop";
  }

  const action: ReconcileOneShotAction = shouldBeActive ? "activate" : "deactivate";

  // `updateMany` with `oneShot:true` is structurally a no-op on every
  // non-one-shot row; collapse to zero count when the medication is
  // not actually one-shot (defence-in-depth against the early-return).
  await prismaClient.medication.updateMany({
    where: { id: medicationId, userId, oneShot: true },
    data: { active: shouldBeActive },
  });

  await auditLog("medication.oneShot.reconciled", {
    userId,
    details: { medicationId, action },
  });

  annotate({
    action: { name: "medication.oneShot.reconciled" },
    meta: { medication_id: medicationId, action },
  });

  return action;
}

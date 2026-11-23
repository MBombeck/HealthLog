/**
 * `DELETE /api/cycle/all` — one-click cycle hard-delete purge.
 *
 * Distinct from the per-row soft-delete (`DELETE /api/cycle/day-logs/{id}`,
 * which leaves a tombstone for the sync feed): this HARD-deletes every
 * cycle row the user owns — day-logs (and their symptom links, by cascade),
 * menstrual cycles, predictions, the cycle audit trail, and the cycle
 * reminder-delivery rows in the push-attempts ledger — so no dated
 * reproductive trace survives in Postgres (the post-Dobbs threat model). The
 * `CycleProfile` row is left in place (gate + settings keep working) but its
 * intent-revealing fields — goal + cycle/period/luteal priors, and the
 * pregnancy or postpartum state — are reset to neutral defaults, so no
 * reproductive intent survives either.
 *
 * The feed is reset in the same transaction (`stampSyncReset`), so a paired
 * client drops its mirror of the purged rows on its next pull.
 *
 * Gated (`cycle.disabled` 403) and owner-scoped. The purge action itself IS
 * audited (written after the transaction, so it survives) — its `details`
 * carry only counts, no reproductive content.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, getClientIp } from "@/lib/api-response";
import { requireCycleEnabled } from "@/lib/cycle/gate";
import { PREGNANCY_CLEARED } from "@/lib/cycle/pregnancy-store";
import { stampSyncReset } from "@/lib/sync/reset";

export const DELETE = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const gate = await requireCycleEnabled(user.id, user.gender);
  if (!gate.enabled) return gate.response;

  // Hard delete in a transaction. Symptom links cascade off the day-log
  // delete (the schema's onDelete: Cascade). Order child-before-parent for
  // the rows that don't cascade.
  const cleared = await prisma.$transaction(async (tx) => {
    const dayLogs = await tx.cycleDayLog.deleteMany({
      where: { userId: user.id },
    });
    // Per-user custom symptoms carry an intent-revealing free-text label
    // (encrypted at rest). A purge that promises "nothing reproductive
    // persists" must drop them too; their links cascade off the row delete.
    const customSymptoms = await tx.cycleSymptom.deleteMany({
      where: { userId: user.id },
    });
    const predictions = await tx.cyclePrediction.deleteMany({
      where: { userId: user.id },
    });
    const cycles = await tx.menstrualCycle.deleteMany({
      where: { userId: user.id },
    });
    // The cycle audit trail carries dated reproductive-adjacent details
    // (period boundaries, the AVOID_PREGNANCY goal-nudge, goal changes). A
    // purge that promises "nothing reproductive persists" must clear it too.
    // The purge's own audit row is written AFTER this transaction, so it
    // survives (counts only, no reproductive content).
    const auditRows = await tx.auditLog.deleteMany({
      where: {
        userId: user.id,
        OR: [
          { action: { startsWith: "cycle." } },
          { action: "user.cycle-prefs.update" },
        ],
      },
    });
    // The shared push-attempts ledger holds dated cycle reminder-delivery
    // rows (eventType + createdAt) for up to 90 days — drop the cycle ones.
    const pushRows = await tx.pushAttempt.deleteMany({
      where: {
        userId: user.id,
        eventType: {
          in: [
            "CYCLE_PERIOD_SOON",
            "CYCLE_PERIOD_CONFIRM",
            "CYCLE_FERTILE_SOON",
          ],
        },
      },
    });
    // Reset the reproductive INTENT carried on the profile (goal + cycle/period/
    // luteal priors) to neutral defaults so a purge leaves no intent-revealing
    // state, while keeping the row so the gate + settings keep working. The
    // pregnancy or postpartum state goes with it: left behind it kept the
    // emergency card, the report and the Coach saying "pregnant".
    await tx.cycleProfile.updateMany({
      where: { userId: user.id },
      data: {
        goal: "GENERAL_HEALTH",
        typicalCycleLength: null,
        typicalPeriodLength: null,
        lutealPhaseLength: null,
        ...PREGNANCY_CLEARED,
      },
    });
    // The rows are gone without tombstones (a tombstone would keep the dated
    // trace the purge exists to remove), so a paired client that mirrored
    // them could never learn of it from the feed. Reset the feed in the same
    // transaction: every cursor issued before now answers `cursorExpired`
    // with reason `sync_reset`, and the client rebuilds without the rows.
    await stampSyncReset(tx, user.id);
    return {
      dayLogs: dayLogs.count,
      customSymptoms: customSymptoms.count,
      predictions: predictions.count,
      cycles: cycles.count,
      auditRows: auditRows.count,
      pushRows: pushRows.count,
    };
  });

  await auditLog("cycle.purge", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: cleared,
  });

  // The purge removes every row the cached cycle context was built on —
  // evict the analytics bucket.
  invalidateUserHealthContext(user.id);

  annotate({
    action: { name: "cycle.purge" },
    meta: cleared,
  });

  return apiSuccess({ purged: true, ...cleared });
});

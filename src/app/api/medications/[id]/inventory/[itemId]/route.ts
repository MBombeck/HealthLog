/**
 * v1.4.25 W19b — per-pen inventory item operations.
 *
 *   PATCH  /api/medications/[id]/inventory/[itemId]
 *     - mark-as-first-use (starts the 30-day clock manually)
 *     - mark-as-used-up (terminal — operator override when a pen is
 *       physically discarded but the dose ledger hasn't reached zero)
 *     - update printed expiry (e.g. carton label correction)
 *     - update notes
 *
 *   DELETE /api/medications/[id]/inventory/[itemId]
 *     - hard delete; admin / cleanup path. The audit log captures
 *       the before-state so a row can be reconstructed if needed.
 */

import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { updateInventoryItemSchema } from "@/lib/validations/medication";
import {
  computeExpiresAt,
  computeInventoryState,
} from "@/lib/medications/inventory/state-machine";

type RouteParams = { params: Promise<{ id: string; itemId: string }> };

async function loadOwnedItem(
  medicationId: string,
  itemId: string,
  userId: string,
) {
  const item = await prisma.medicationInventoryItem.findUnique({
    where: { id: itemId },
  });
  if (!item || item.userId !== userId || item.medicationId !== medicationId) {
    return null;
  }
  return item;
}

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id, itemId } = await params;

    const existing = await loadOwnedItem(id, itemId, user.id);
    if (!existing) return apiError("Inventory item not found", 404);

    const { data: body, error: jsonError } = await safeJson(request);
    if (jsonError) return jsonError;

    const parsed = updateInventoryItemSchema.safeParse(body);
    if (!parsed.success) {
      // v1.4.43 W6 — multi-issue 422.
      return returnAllZodIssues(parsed.error, 422);
    }

    const { markAsFirstUseAt, markAsUsedUp, printedExpiry, notes } =
      parsed.data;

    // Compose the next-row shape. Each mutation field is optional and
    // commutative — applying them in any order produces the same row.
    let nextFirstUseAt = existing.firstUseAt;
    let nextState = existing.state;
    let nextDosesRemaining = existing.dosesRemaining;
    let nextPrintedExpiry = existing.printedExpiry;

    if (markAsFirstUseAt) {
      // The clock can be set manually if the user opened the pen
      // without logging an intake event.
      nextFirstUseAt = markAsFirstUseAt;
      if (nextState === "ACTIVE") nextState = "IN_USE";
    }

    if (printedExpiry !== undefined) {
      nextPrintedExpiry = printedExpiry;
    }

    if (markAsUsedUp === true) {
      nextDosesRemaining = 0;
      nextState = "USED_UP";
    }

    const nextExpiresAt = computeExpiresAt(nextFirstUseAt, nextPrintedExpiry);

    // Re-run the canonical state machine over the composed next-row
    // view. The clause-by-clause updates above set the state ad-hoc
    // (`ACTIVE → IN_USE` on first use, `* → USED_UP` on mark-as-used),
    // but a back-dated `markAsFirstUseAt` whose 30-day window already
    // elapsed should land at EXPIRED, not IN_USE. The state machine is
    // pure and idempotent — running it once more with the composed view
    // collapses every edge case onto the same decision tree the intake
    // hook and the daily expire cron already share. USED_UP is terminal
    // (dosesRemaining === 0 ⇒ USED_UP wins at clause 1), so the manual
    // override remains sticky.
    nextState = computeInventoryState(
      {
        state: nextState,
        dosesTotal: existing.dosesTotal,
        dosesRemaining: nextDosesRemaining,
        firstUseAt: nextFirstUseAt,
        printedExpiry: nextPrintedExpiry,
      },
      Date.now(),
    );

    const updated = await prisma.medicationInventoryItem.update({
      where: { id: itemId },
      data: {
        state: nextState,
        firstUseAt: nextFirstUseAt,
        dosesRemaining: nextDosesRemaining,
        printedExpiry: nextPrintedExpiry,
        expiresAt: nextExpiresAt,
        notes: notes === undefined ? existing.notes : notes,
      },
    });

    await auditLog("medication.inventory.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        medicationId: id,
        itemId,
        prevState: existing.state,
        nextState: updated.state,
      },
    });

    annotate({
      action: {
        name: "medication.inventory.update",
        entity_type: "inventory_item",
        entity_id: itemId,
      },
      meta: { medication_id: id, prev: existing.state, next: updated.state },
    });

    return apiSuccess(updated);
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id, itemId } = await params;

    const existing = await loadOwnedItem(id, itemId, user.id);
    if (!existing) return apiError("Inventory item not found", 404);

    await prisma.medicationInventoryItem.delete({ where: { id: itemId } });

    await auditLog("medication.inventory.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        medicationId: id,
        itemId,
        finalState: existing.state,
        dosesRemaining: existing.dosesRemaining,
      },
    });

    annotate({
      action: {
        name: "medication.inventory.delete",
        entity_type: "inventory_item",
        entity_id: itemId,
      },
      meta: { medication_id: id },
    });

    return apiSuccess({ id: itemId, deleted: true });
  },
);

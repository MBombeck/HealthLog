/**
 * v1.4.25 — per-pen inventory item operations.
 *
 *   PATCH  /api/medications/[id]/inventory/[itemId]
 *     - set or clear the opening date (`markAsFirstUseAt`); for a pen
 *       or an ampoule it also starts / stops the in-use clock
 *     - mark-as-used-up (terminal — operator override when a pen is
 *       physically discarded but the dose ledger hasn't reached zero)
 *     - update printed expiry (e.g. carton label correction)
 *     - stock correction via `unitsRemaining` (v1.16.1 — the Bestand
 *       tab's adjust / withdraw flow; clamped to `unitsTotal`, state
 *       re-derived by the canonical state machine; v1.16.10 renamed
 *       the request field from `dosesRemaining` to match the response)
 *     - update notes
 *
 *   DELETE /api/medications/[id]/inventory/[itemId]
 *     - hard delete; admin / cleanup path. The audit log captures
 *       the before-state so a row can be reconstructed if needed.
 */

import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import {
  destroyedDetails,
  overwriteDetails,
} from "@/lib/sharing/audit-details";
import { annotate } from "@/lib/logging/context";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { updateInventoryItemSchema } from "@/lib/validations/medication";
import {
  computeExpiresAt,
  computeInventoryState,
} from "@/lib/medications/inventory/state-machine";
import { serializeInventoryItem } from "@/lib/medications/inventory/service";
import { lockMedicationInventory } from "@/lib/medications/inventory/consumption";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { encryptNote, shapeInventoryItemNotes } from "@/lib/crypto/note-cipher";

type RouteParams = { params: Promise<{ id: string; itemId: string }> };

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. Correcting a stock item's state or count.
    const { user } = await requireRecordAuth("manage", "medications");
    const { id, itemId } = await params;

    const parsed = await parseJsonBody(request, updateInventoryItemSchema, {
      maxBytes: 64 * 1024,
    });
    if (!parsed.ok) return parsed.error;

    const {
      markAsFirstUseAt,
      markAsUsedUp,
      printedExpiry,
      unitsRemaining,
      manufacturer,
      doseStrength,
      notes,
    } = parsed.data;

    // Only touch the note columns when the caller supplied a value; an absent
    // `notes` leaves the existing ciphertext untouched. When present, encrypt
    // at rest and null the plaintext column.
    const notesData =
      notes === undefined
        ? {}
        : { notesEncrypted: encryptNote(notes), notes: null };

    // Carton labelling follows the same absent-means-untouched rule as
    // `notes`: an omitted field must not blank a value the other client
    // populated. Built field by field, never spread from the parsed body.
    const labellingData: {
      manufacturer?: string | null;
      doseStrength?: string | null;
    } = {};
    if (manufacturer !== undefined) labellingData.manufacturer = manufacturer;
    if (doseStrength !== undefined) labellingData.doseStrength = doseStrength;

    // v1.32.22 — the stock correction writes an ABSOLUTE `unitsRemaining`
    // composed from a prior read. `consumeForIntake` decrements the same rows
    // under a per-medication advisory lock; without taking that SAME lock the
    // correction's read-compose-write could clobber a concurrent decrement (or
    // vice versa). Route the whole read-compose-write through one transaction
    // that takes the lock first and re-reads INSIDE it, so the correction
    // serializes against intake consumption instead of racing it.
    const outcome = await prisma.$transaction(async (tx) => {
      await lockMedicationInventory(tx, id);

      const existing = await tx.medicationInventoryItem.findUnique({
        where: { id: itemId },
      });
      if (
        !existing ||
        existing.userId !== user.id ||
        existing.medicationId !== id
      ) {
        return { notFound: true as const };
      }

      // Compose the next-row shape. Each mutation field is optional and
      // commutative — applying them in any order produces the same row.
      let nextFirstUseAt = existing.firstUseAt;
      let nextState = existing.state;
      // v1.16.12 — Decimal column; work in JS numbers locally (the
      // arithmetic below stays well within double precision) and let
      // Prisma re-widen on write.
      let nextUnitsRemaining: number = Number(existing.unitsRemaining);
      let nextPrintedExpiry = existing.printedExpiry;

      if (markAsFirstUseAt !== undefined) {
        // The opening date can be set manually if the user opened the
        // container without logging an intake event — and cleared
        // (null) when it was never opened at all. An auto-open the
        // consumption hook wrote from a back-dated intake is the one
        // the user most often has to take back, and until now nothing
        // could unset it.
        nextFirstUseAt = markAsFirstUseAt;
        if (nextState === "ACTIVE" && markAsFirstUseAt !== null) {
          nextState = "IN_USE";
        }
      }

      if (printedExpiry !== undefined) {
        nextPrintedExpiry = printedExpiry;
      }

      if (unitsRemaining !== undefined) {
        // v1.16.1 — stock correction (Bestand tab adjust / withdraw).
        // The wire field counts UNITS. Clamp to the item's capacity; the
        // state-machine re-run below owns every state consequence (0 ⇒
        // USED_UP, a raise out of 0 re-evaluates against the expiry
        // clocks).
        nextUnitsRemaining = Math.min(
          unitsRemaining,
          Number(existing.unitsTotal),
        );
      }

      if (markAsUsedUp === true) {
        nextUnitsRemaining = 0;
        nextState = "USED_UP";
      }

      const nextExpiresAt = computeExpiresAt(
        nextFirstUseAt,
        nextPrintedExpiry,
        existing.containerType,
      );

      // Re-run the canonical state machine over the composed next-row
      // view. The clause-by-clause updates above set the state ad-hoc
      // (`ACTIVE → IN_USE` on first use, `* → USED_UP` on mark-as-used),
      // but a back-dated `markAsFirstUseAt` whose 30-day window already
      // elapsed should land at EXPIRED, not IN_USE. The state machine is
      // pure and idempotent — running it once more with the composed view
      // collapses every edge case onto the same decision tree the intake
      // hook and the daily expire cron already share. USED_UP is terminal
      // (unitsRemaining === 0 ⇒ USED_UP wins at clause 1), so the manual
      // override remains sticky.
      nextState = computeInventoryState(
        {
          state: nextState,
          containerType: existing.containerType,
          unitsTotal: Number(existing.unitsTotal),
          unitsRemaining: nextUnitsRemaining,
          firstUseAt: nextFirstUseAt,
          printedExpiry: nextPrintedExpiry,
        },
        Date.now(),
      );

      const updated = await tx.medicationInventoryItem.update({
        where: { id: itemId },
        data: {
          state: nextState,
          firstUseAt: nextFirstUseAt,
          unitsRemaining: nextUnitsRemaining,
          printedExpiry: nextPrintedExpiry,
          expiresAt: nextExpiresAt,
          ...labellingData,
          ...notesData,
        },
      });

      return {
        prevState: existing.state,
        // v1.37.0 — the pre-image the audit row carries (C4).
        previous: {
          unitsRemaining: Number(existing.unitsRemaining),
          unitsTotal: Number(existing.unitsTotal),
          firstUseAt: existing.firstUseAt,
          printedExpiry: existing.printedExpiry,
        },
        updated,
      };
    });

    if ("notFound" in outcome) return apiError("Inventory item not found", 404);
    const { prevState, previous, updated } = outcome;

    await auditLog("medication.inventory.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      // The counts and dates this edit replaced, beside the state
      // transition the row already carried.
      details: {
        medicationId: id,
        itemId,
        prevState,
        nextState: updated.state,
        ...overwriteDetails({
          before: {
            unitsRemaining: previous.unitsRemaining,
            unitsTotal: previous.unitsTotal,
            firstUseAt: previous.firstUseAt,
            printedExpiry: previous.printedExpiry,
          },
          after: {
            unitsRemaining: Number(updated.unitsRemaining),
            unitsTotal: Number(updated.unitsTotal),
            firstUseAt: updated.firstUseAt,
            printedExpiry: updated.printedExpiry,
          },
        }),
      },
    });

    annotate({
      action: {
        name: "medication.inventory.update",
        entity_type: "inventory_item",
        entity_id: itemId,
      },
      meta: { medication_id: id, prev: prevState, next: updated.state },
    });

    // A stock correction / first-use / used-up flip changes the
    // dose-derived stock the medications-list payload carries, which the
    // card and table render. Hard-evict so the supply shows on the next
    // read instead of after the `cachedSwr` stale window.
    invalidateUserMedications(user.id, { evict: true });

    return apiSuccess(serializeInventoryItem(shapeInventoryItemNotes(updated)));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE, and a hard delete. The audit row already carried the
    // final state and the units left; C3 adds what the container WAS.
    const { user } = await requireRecordAuth("manage", "medications");
    const { id, itemId } = await params;

    // v1.32.22 — take the same per-medication advisory lock the intake
    // consumption hook takes, so a delete that interleaves a `consumeForIntake`
    // serializes against it: the consume either fully applies before the row
    // vanishes or blocks until the delete commits and then finds nothing to
    // decrement, instead of half-applying against a row deleted mid-flight.
    const existing = await prisma.$transaction(async (tx) => {
      await lockMedicationInventory(tx, id);
      const item = await tx.medicationInventoryItem.findUnique({
        where: { id: itemId },
      });
      if (!item || item.userId !== user.id || item.medicationId !== id) {
        return null;
      }
      await tx.medicationInventoryItem.delete({ where: { id: itemId } });
      return item;
    });
    if (!existing) return apiError("Inventory item not found", 404);

    await auditLog("medication.inventory.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      // The container's own identity: its label, its expiry, what it
      // held. The row is gone; this is what is left of it.
      details: {
        medicationId: id,
        itemId,
        finalState: existing.state,
        unitsRemaining: Number(existing.unitsRemaining),
        ...destroyedDetails({
          model: "MedicationInventoryItem",
          id: itemId,
          label:
            existing.doseStrength ??
            existing.manufacturer ??
            existing.containerType,
          effectiveAt: existing.expiresAt ?? existing.printedExpiry,
          extra: {
            containerType: existing.containerType,
            unitsTotal: Number(existing.unitsTotal),
            printedExpiry: existing.printedExpiry,
          },
        }),
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

    // Removing a container changes the dose-derived stock the
    // medications-list payload carries. Hard-evict so the card / table
    // reflect the drop on the very next read.
    invalidateUserMedications(user.id, { evict: true });

    return apiSuccess({ id: itemId, deleted: true });
  },
);

/**
 * v1.4.25 W4d — GLP-1 medication details endpoint.
 *
 * Returns per-medication extras the GLP-1 card variant + the dashboard
 * tile + the doctor-report PDF section read: chronological dose-change
 * history, the last 12 injection events (with optional site
 * rotation data), and the running pen-inventory math. The base
 * /api/medications/[id] GET is unchanged so v1.4.24 consumers keep
 * working untouched.
 */

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

const LOW_STOCK_DOSE_THRESHOLD = 4;

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    const medication = await prisma.medication.findUnique({
      where: { id },
      include: {
        doseChanges: { orderBy: { effectiveFrom: "asc" } },
        inventoryEvents: { orderBy: { occurredAt: "asc" } },
        intakeEvents: {
          where: { takenAt: { not: null } },
          orderBy: { takenAt: "desc" },
          take: 12,
          select: { takenAt: true, injectionSite: true },
        },
        schedules: true,
      },
    });

    if (!medication || medication.userId !== user.id) {
      return apiError("Medication not found", 404);
    }

    // Inventory math: running sum of every inventory event. Negative
    // when more doses were consumed than purchased — surfaces as a
    // low-stock warning rather than a hard error so the UI keeps
    // working when the user backdates an inventory event.
    let inventory: {
      pensRemaining: number | null;
      dosesRemaining: number | null;
      weeksOfSupply: number | null;
      lowStock: boolean;
    } | null = null;
    if (medication.dosesPerUnit && medication.inventoryEvents.length > 0) {
      const pens = medication.inventoryEvents.reduce(
        (sum, ev) => sum + ev.delta,
        0,
      );
      const pensRemaining = Math.max(0, pens);
      const dosesRemaining = pensRemaining * medication.dosesPerUnit;
      // Approximate weeks-of-supply assuming weekly cadence (the
      // canonical GLP-1 case). The Coach snapshot does the same.
      const weeksOfSupply = dosesRemaining;
      const lowStock = dosesRemaining < LOW_STOCK_DOSE_THRESHOLD;
      inventory = {
        pensRemaining,
        dosesRemaining,
        weeksOfSupply,
        lowStock,
      };
    }

    return apiSuccess({
      doseChanges: medication.doseChanges.map((dc) => ({
        id: dc.id,
        effectiveFrom: dc.effectiveFrom.toISOString(),
        doseValue: dc.doseValue,
        doseUnit: dc.doseUnit,
        note: dc.note,
      })),
      recentIntakes: medication.intakeEvents.map((iv) => ({
        takenAt: iv.takenAt ? iv.takenAt.toISOString() : null,
        injectionSite: iv.injectionSite,
      })),
      inventory,
    });
  },
);

const doseChangeSchema = {
  effectiveFrom: "string",
  doseValue: "number",
  doseUnit: "string",
  note: "string?",
} as const;

const inventorySchema = {
  delta: "number",
  reason: "string",
} as const;

void doseChangeSchema;
void inventorySchema;

interface DoseChangeBody {
  effectiveFrom?: string;
  doseValue?: number;
  doseUnit?: string;
  note?: string | null;
}

interface InventoryBody {
  delta?: number;
  reason?: string;
}

interface Glp1PostBody {
  doseChange?: DoseChangeBody;
  inventory?: InventoryBody;
}

/**
 * POST creates a new dose change OR inventory event (the body picks
 * one — caller specifies which). Convenience endpoint so the
 * medication-card disclosure can write rows without dispatching to
 * /api/medications/[id]/dose-change + /api/medications/[id]/inventory
 * separately for the v1.4.25 cut.
 */
export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;
    const medication = await prisma.medication.findUnique({ where: { id } });
    if (!medication || medication.userId !== user.id) {
      return apiError("Medication not found", 404);
    }

    const body = (await request
      .json()
      .catch(() => null)) as Glp1PostBody | null;
    if (!body) return apiError("Invalid body", 400);

    if (body.doseChange) {
      const { effectiveFrom, doseValue, doseUnit, note } = body.doseChange;
      if (!effectiveFrom || typeof doseValue !== "number" || !doseUnit) {
        return apiError(
          "doseChange.effectiveFrom + doseValue + doseUnit required",
          422,
        );
      }
      const created = await prisma.medicationDoseChange.create({
        data: {
          medicationId: id,
          effectiveFrom: new Date(effectiveFrom),
          doseValue,
          doseUnit,
          note: note ?? null,
        },
      });
      return apiSuccess({ doseChange: created }, 201);
    }

    if (body.inventory) {
      const { delta, reason } = body.inventory;
      if (typeof delta !== "number" || !reason) {
        return apiError("inventory.delta + reason required", 422);
      }
      const created = await prisma.medicationInventoryEvent.create({
        data: { medicationId: id, delta, reason },
      });
      return apiSuccess({ inventory: created }, 201);
    }

    return apiError("Body must carry doseChange or inventory", 422);
  },
);

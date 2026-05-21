/**
 * v1.4.25 W4d — GLP-1 medication details endpoint.
 *
 * Returns per-medication extras the GLP-1 card variant + the dashboard
 * tile + the doctor-report PDF section read: chronological dose-change
 * history, the last 12 injection events (with optional site
 * rotation data), and the running pen-inventory math. The base
 * /api/medications/[id] GET is unchanged so v1.4.24 consumers keep
 * working untouched.
 *
 * v1.4.25 W21 Fix-K — POST hardened with Zod parse, audit-log, 30/min
 * rate-limit, finite-number guard on `doseValue`, length cap on `note`,
 * and sane bounds on `effectiveFrom`. Mirrors the sibling
 * `/inventory` + `/side-effects` route shape.
 */

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
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { glp1PostBodySchema } from "@/lib/validations/medication";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

const LOW_STOCK_DOSE_THRESHOLD = 4;
const POST_RATE_LIMIT = 30;
const POST_WINDOW_MS = 60_000;

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

/**
 * POST creates a new dose change OR inventory event (the body picks
 * one — caller specifies which). Convenience endpoint so the
 * medication-card disclosure can write rows without dispatching to
 * /api/medications/[id]/dose-change + /api/medications/[id]/inventory
 * separately for the v1.4.25 cut.
 *
 * Validation: `glp1PostBodySchema` (XOR of `doseChange` / `inventory`),
 * with finite-number guards on `doseValue` + `delta`, bounded `note`
 * + `reason`, and a ±5-year window on `effectiveFrom`.
 * Rate-limit: 30/min/user (same as sibling POST routes).
 * Audit: `medication.glp1.update` for every successful mutation.
 */
export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    // Per-user POST rate-limit — matches the 30/min sibling routes
    // (inventory, side-effects). Generous for a hand-driven session,
    // tight enough to cut off the spam case.
    const rl = await checkRateLimit(
      `medication-glp1:post:${user.id}`,
      POST_RATE_LIMIT,
      POST_WINDOW_MS,
    );
    if (!rl.allowed) {
      return apiError("Too many requests", 429, {
        headers: rateLimitHeaders(rl),
      });
    }

    const { data: body, error: jsonError } = await safeJson(request);
    if (jsonError) return jsonError;

    const parsed = glp1PostBodySchema.safeParse(body);
    if (!parsed.success) {
      // v1.4.43 W6 — multi-issue 422.
      return returnAllZodIssues(parsed.error, 422);
    }

    const ip = getClientIp(request);

    if (parsed.data.doseChange) {
      const { effectiveFrom, doseValue, doseUnit, note } =
        parsed.data.doseChange;
      const created = await prisma.medicationDoseChange.create({
        data: {
          medicationId: id,
          effectiveFrom,
          doseValue,
          doseUnit,
          note: note ?? null,
        },
      });

      await auditLog("medication.glp1.update", {
        userId: user.id,
        ipAddress: ip,
        details: {
          medicationId: id,
          kind: "doseChange",
          doseChangeId: created.id,
          doseValue,
          doseUnit,
        },
      });

      annotate({
        action: {
          name: "medication.glp1.doseChange.create",
          entity_type: "medication_dose_change",
          entity_id: created.id,
        },
        meta: { medication_id: id, doseValue, doseUnit },
      });

      return apiSuccess({ doseChange: created }, 201);
    }

    // The schema's XOR refinement guarantees `inventory` is present
    // when `doseChange` is not, so the non-null assertion is safe.
    const { delta, reason } = parsed.data.inventory!;
    const created = await prisma.medicationInventoryEvent.create({
      data: { medicationId: id, delta, reason },
    });

    await auditLog("medication.glp1.update", {
      userId: user.id,
      ipAddress: ip,
      details: {
        medicationId: id,
        kind: "inventory",
        inventoryEventId: created.id,
        delta,
        reason,
      },
    });

    annotate({
      action: {
        name: "medication.glp1.inventory.create",
        entity_type: "medication_inventory_event",
        entity_id: created.id,
      },
      meta: { medication_id: id, delta },
    });

    return apiSuccess({ inventory: created }, 201);
  },
);

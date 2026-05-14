/**
 * v1.4.25 W19b — pen / vial inventory CRUD.
 *
 *   GET  /api/medications/[id]/inventory  — list (user-scoped, all states)
 *   POST /api/medications/[id]/inventory  — register a new pen / vial
 *
 * Per-item operations live on the `[itemId]` sub-route.
 *
 * Auth: cookie-session via requireAuth(); the medication is verified
 * to belong to the caller before any read/write touches inventory.
 * Rate-limit 30/min/user on the POST path (creation is the only
 * surface that can spam writes; GET is read-only and benign).
 * Audit-log every mutation with the affected itemId.
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
  safeJson,
} from "@/lib/api-response";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { createInventoryItemSchema } from "@/lib/validations/medication";
import { buildCreateInventoryInput } from "@/lib/medications/inventory/service";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";

type RouteParams = { params: Promise<{ id: string }> };

const POST_RATE_LIMIT = 30;
const POST_WINDOW_MS = 60_000;

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const items = await prisma.medicationInventoryItem.findMany({
      where: { userId: user.id, medicationId: id },
      orderBy: [{ state: "asc" }, { expiresAt: "asc" }, { createdAt: "asc" }],
    });

    annotate({
      action: { name: "medication.inventory.list" },
      meta: { medication_id: id, total: items.length },
    });

    return apiSuccess({ items, meta: { total: items.length } });
  },
);

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    // Per-user POST rate-limit — 30/min is generous for normal pen
    // registrations but cuts off the spam case.
    const rl = await checkRateLimit(
      `medication-inventory:post:${user.id}`,
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

    const parsed = createInventoryItemSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 422);
    }

    const { dosesTotal, printedExpiry, purchasedAt, notes } = parsed.data;

    const created = await prisma.medicationInventoryItem.create({
      data: buildCreateInventoryInput({
        userId: user.id,
        medicationId: id,
        dosesTotal,
        printedExpiry: printedExpiry ?? null,
        purchasedAt: purchasedAt ?? null,
        notes: notes ?? null,
      }),
    });

    await auditLog("medication.inventory.create", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        medicationId: id,
        itemId: created.id,
        dosesTotal,
      },
    });

    annotate({
      action: {
        name: "medication.inventory.create",
        entity_type: "inventory_item",
        entity_id: created.id,
      },
      meta: { medication_id: id },
    });

    return apiSuccess(created, 201);
  },
);

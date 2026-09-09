/**
 * v1.4.25 W19b — pen / vial inventory CRUD.
 *
 *   GET  /api/medications/[id]/inventory  — list (user-scoped, all states)
 *   POST /api/medications/[id]/inventory  — register a new pen / vial
 *
 * Per-item operations live on the `[itemId]` sub-route.
 *
 * Auth: cookie-session or Bearer, resolved through `requireRecordAuth`; the
 *   medication is verified
 * to belong to the caller before any read/write touches inventory.
 * Rate-limit 30/min/user on the POST path (creation is the only
 * surface that can spam writes; GET is read-only and benign).
 * Audit-log every mutation with the affected itemId.
 */

import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
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
import { createInventoryItemSchema } from "@/lib/validations/medication";
import {
  buildCreateInventoryInput,
  buildSupplySummary,
  serializeInventoryItem,
} from "@/lib/medications/inventory/service";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { shapeInventoryItemNotes } from "@/lib/crypto/note-cipher";
import { withIdempotency } from "@/lib/idempotency";

type RouteParams = { params: Promise<{ id: string }> };

const POST_RATE_LIMIT = 30;
const POST_WINDOW_MS = 60_000;

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("read", "medications");
    const { id } = await params;

    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const [items, medication] = await Promise.all([
      prisma.medicationInventoryItem.findMany({
        where: { userId: user.id, medicationId: id },
        orderBy: [{ state: "asc" }, { expiresAt: "asc" }, { createdAt: "asc" }],
      }),
      prisma.medication.findUnique({
        where: { id },
        select: { unitsPerDose: true },
      }),
    ]);

    // Decrypt each note and strip the raw `notesEncrypted` ciphertext before
    // the decimal-unit serialisation runs.
    const serialized = items.map((item) =>
      serializeInventoryItem(shapeInventoryItemNotes(item)),
    );
    // v1.19.0 (iOS#25) — the canonical supply summary is computed HERE,
    // server-side, through the one source of truth (`summariseSupply`).
    // The detail-page client renders these ready figures instead of
    // re-deriving them in the browser, so web and iOS read identical
    // numbers from the same DTO.
    const summary = buildSupplySummary(
      serialized,
      medication?.unitsPerDose ? Number(medication.unitsPerDose) : 1,
    );

    annotate({
      action: { name: "medication.inventory.list" },
      meta: { medication_id: id, total: items.length },
    });

    return apiSuccess({
      items: serialized,
      summary,
      meta: { total: items.length },
    });
  },
);

/**
 * Wrapped in `withIdempotency`: registering a container is replayed out of the
 * client's offline outbox under the same `Idempotency-Key`, and a replay after
 * a lost success response would otherwise register the same pen twice and
 * double the stock the low-stock notification reads.
 */
export const POST = apiHandler(
  withIdempotency<[NextRequest, RouteParams]>(postInventoryItem),
);

async function postInventoryItem(
  request: NextRequest,
  { params }: RouteParams,
): Promise<Response> {
  // v1.37.0 — MANAGE. Recording the stock the low-stock notification reads;
  // that notification rings the record's own phone.
  const { user, actor } = await requireRecordAuth("manage", "medications");
  const { id } = await params;

  const guard = await assertMedicationOwnership(id, user.id);
  if (guard) return guard;

  // Per-caller POST rate-limit — 30/min is generous for normal pen
  // registrations but cuts off the spam case.
  //
  // v1.37.0 — C1: the bucket keys on the ACTOR, so a manager burns their
  // own allowance rather than the owner's and cannot collect a fresh one by
  // switching records.
  const rl = await checkRateLimit(
    `medication-inventory:post:${actor.id}`,
    POST_RATE_LIMIT,
    POST_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many requests", 429, {
      headers: rateLimitHeaders(rl),
    });
  }

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = createInventoryItemSchema.safeParse(body);
  if (!parsed.success) {
    // v1.4.43 W6 — multi-issue 422.
    return returnAllZodIssues(parsed.error, 422);
  }

  const {
    unitsTotal,
    containerType,
    printedExpiry,
    purchasedAt,
    manufacturer,
    doseStrength,
    notes,
  } = parsed.data;

  const created = await prisma.medicationInventoryItem.create({
    // The wire field `unitsTotal` counts UNITS (tablets / ampoules /
    // puffs) — v1.16.10 renamed the request field to match the
    // response side.
    data: buildCreateInventoryInput({
      userId: user.id,
      medicationId: id,
      unitsTotal,
      containerType: containerType ?? "OTHER",
      printedExpiry: printedExpiry ?? null,
      purchasedAt: purchasedAt ?? null,
      manufacturer: manufacturer ?? null,
      doseStrength: doseStrength ?? null,
      notes: notes ?? null,
    }),
  });

  await auditLog("medication.inventory.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      medicationId: id,
      itemId: created.id,
      unitsTotal,
      containerType: created.containerType,
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

  // A registered container changes the dose-derived stock the
  // medications-list payload carries (`stockUnitsRemaining` /
  // `stockDosesRemaining`), which the card and table render. Hard-evict
  // the per-user medications + compliance buckets so the supply shows on
  // the very next read — a mark-stale would let the `cachedSwr` list
  // serve the pre-write stock for the rest of the stale window.
  invalidateUserMedications(user.id, { evict: true });

  return apiSuccess(
    serializeInventoryItem(shapeInventoryItemNotes(created)),
    201,
  );
}

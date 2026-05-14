/**
 * v1.4.25 W19d — GLP-1 side-effect log CRUD (collection).
 *
 *   GET  /api/medications/[id]/side-effects?from=ISO&to=ISO&limit=50
 *     - returns the user's logs for this medication, newest first,
 *       optionally bounded by an [from, to) window.
 *
 *   POST /api/medications/[id]/side-effects
 *     - creates a new entry. Body: { category, entry, severity,
 *       occurredAt?, notes? }. Category is verified against the
 *       authoritative entry → category mapping; mismatch → 422.
 *
 * Auth: cookie-session via requireAuth(); the medication is verified
 * to belong to the caller before any read/write.
 * Rate-limit: 30/min/user on the POST path.
 * Audit-log every mutation with the affected row id.
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
import {
  createSideEffectSchema,
  listSideEffectsSchema,
} from "@/lib/medications/side-effects/validators";
import { categoryForEntry } from "@/lib/medications/side-effects/taxonomy";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";

type RouteParams = { params: Promise<{ id: string }> };

const POST_RATE_LIMIT = 30;
const POST_WINDOW_MS = 60_000;

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const url = new URL(request.url);
    const parsed = listSideEffectsSchema.safeParse({
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 422);
    }

    const { from, to, limit } = parsed.data;

    const items = await prisma.medicationSideEffect.findMany({
      where: {
        userId: user.id,
        medicationId: id,
        ...(from || to
          ? {
              occurredAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lt: to } : {}),
              },
            }
          : {}),
      },
      orderBy: { occurredAt: "desc" },
      take: limit,
    });

    annotate({
      action: { name: "medication.sideEffect.list" },
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

    // Per-user POST rate-limit — 30/min comfortably absorbs a session
    // of bulk back-fill (e.g. "log yesterday's symptoms") while cutting
    // off automated abuse.
    const rl = await checkRateLimit(
      `medication-side-effect:post:${user.id}`,
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

    const parsed = createSideEffectSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 422);
    }

    const { entry, severity, occurredAt, notes } = parsed.data;

    // v1.4.25 W21 Fix-N (code-M6) — category is derived server-side
    // from the entry via the authoritative taxonomy mapping. The wire
    // schema no longer accepts `category`; older clients that still
    // send it now have it ignored by Zod's strict drop, and the row
    // lands with the correct (entry-derived) category every time.
    const category = categoryForEntry(entry);

    const created = await prisma.medicationSideEffect.create({
      data: {
        userId: user.id,
        medicationId: id,
        category,
        entry,
        severity,
        occurredAt: occurredAt ?? new Date(),
        notes: notes ?? null,
      },
    });

    await auditLog("medication.sideEffect.create", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        medicationId: id,
        sideEffectId: created.id,
        entry,
        severity,
      },
    });

    annotate({
      action: {
        name: "medication.sideEffect.create",
        entity_type: "medication_side_effect",
        entity_id: created.id,
      },
      meta: { medication_id: id, entry, severity },
    });

    return apiSuccess(created, 201);
  },
);

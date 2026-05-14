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

type RouteParams = { params: Promise<{ id: string }> };

const POST_RATE_LIMIT = 30;
const POST_WINDOW_MS = 60_000;

async function assertMedicationOwnership(
  medicationId: string,
  userId: string,
) {
  const med = await prisma.medication.findUnique({
    where: { id: medicationId },
    select: { id: true, userId: true },
  });
  if (!med || med.userId !== userId) {
    return apiError("Medication not found", 404);
  }
  return null;
}

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
      const response = apiError("Too many requests", 429);
      for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
        response.headers.set(k, v);
      }
      return response;
    }

    const { data: body, error: jsonError } = await safeJson(request);
    if (jsonError) return jsonError;

    const parsed = createSideEffectSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 422);
    }

    const { category, entry, severity, occurredAt, notes } = parsed.data;

    // Authoritative category derivation. The client-supplied category
    // is sanity-checked, never trusted — a NAUSEA row tagged as
    // INJECTION_SITE would poison the Coach aggregator.
    const expectedCategory = categoryForEntry(entry);
    if (expectedCategory !== category) {
      return apiError(
        `Entry ${entry} belongs to category ${expectedCategory}, not ${category}`,
        422,
      );
    }

    const created = await prisma.medicationSideEffect.create({
      data: {
        userId: user.id,
        medicationId: id,
        category: expectedCategory,
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

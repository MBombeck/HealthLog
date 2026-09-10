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
 * Auth: a session via requireRecordAuth(); the medication is verified to
 * belong to the RECORD before any read/write, so a delegate reaches the
 * owner's medications and none of their own.
 * Rate-limit: 30/min on the POST path, keyed on the ACTOR (see the call site).
 * Audit-log every mutation with the affected row id.
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
import {
  createSideEffectSchema,
  listSideEffectsSchema,
} from "@/lib/medications/side-effects/validators";
import { categoryForEntry } from "@/lib/medications/side-effects/taxonomy";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { encryptNote, shapeSideEffectNotes } from "@/lib/crypto/note-cipher";
import { withIdempotency } from "@/lib/idempotency";

type RouteParams = { params: Promise<{ id: string }> };

const POST_RATE_LIMIT = 30;
const POST_WINDOW_MS = 60_000;

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("read", "medications");
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
      // v1.4.43 W6 — multi-issue 422.
      return returnAllZodIssues(parsed.error, 422);
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

    // Decrypt each note and strip the raw `notesEncrypted` ciphertext so it
    // never leaves the server.
    return apiSuccess({
      items: items.map(shapeSideEffectNotes),
      meta: { total: items.length },
    });
  },
);

/**
 * Wrapped in `withIdempotency`: the client replays this write out of its
 * offline outbox with the same `Idempotency-Key`, and a replay after a lost
 * success response must not log the same symptom twice. Nothing else on this
 * row is unique, so the wrapper is the only thing that can collapse a retry.
 */
export const POST = apiHandler(
  withIdempotency<[NextRequest, RouteParams]>(postSideEffect),
);

async function postSideEffect(
  request: NextRequest,
  { params }: RouteParams,
): Promise<Response> {
  // v1.36.x — a delegated write. `user` is the record the entry lands under;
  // `actor` is whoever is typing, and the two differ only under a switch.
  const { user, actor } = await requireRecordAuth("write", "medications");
  const { id } = await params;

  const guard = await assertMedicationOwnership(id, user.id);
  if (guard) return guard;

  // Per-caller POST rate-limit — 30/min comfortably absorbs a session
  // of bulk back-fill (e.g. "log yesterday's symptoms") while cutting
  // off automated abuse.
  //
  // v1.36.x — the bucket keys on the ACTOR, not on the resolved record, and
  // this is the one condition on which delegating this verb was admitted. On
  // the record key a delegate could exhaust the owner's allowance and lock
  // them out of their own log, and could collect a fresh one by switching to
  // another record. On the actor key they burn their own, once, wherever
  // they are. `medications/compliance` set the same precedent on the read
  // side. `actor.id` equals `user.id` for everyone who has not switched, so
  // the bucket a self-writer lands in is byte-identical to before.
  const rl = await checkRateLimit(
    `medication-side-effect:post:${actor.id}`,
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

  const parsed = createSideEffectSchema.safeParse(body);
  if (!parsed.success) {
    // v1.4.43 W6 — multi-issue 422.
    return returnAllZodIssues(parsed.error, 422);
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
      // Encrypt the free-text note at rest; the plaintext column stays null.
      notesEncrypted: encryptNote(notes),
      notes: null,
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

  return apiSuccess(shapeSideEffectNotes(created), 201);
}

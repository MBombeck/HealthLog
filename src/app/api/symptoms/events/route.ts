/**
 * Occurrences of person-defined symptoms (v1.40).
 *
 *   GET  /api/symptoms/events — newest first, optionally narrowed by
 *        `from` / `to` (ISO instants), `definitionId` and `episodeId`; at most
 *        500 per page.
 *   POST /api/symptoms/events — log one (`{ definitionId, intensity,
 *        occurredAt?, note?, episodeId? }`). `occurredAt` defaults to now and
 *        may not lie in the future beyond the shared five-minute skew;
 *        `episodeId` must name one of the record's own episodes that is still
 *        open or that ran over `occurredAt`. The note is encrypted at rest.
 *
 * Module-gated on the record (`illness.disabled`). `userId` comes from auth
 * and is never a body field.
 */
import { NextRequest } from "next/server";

import { listPage } from "@/lib/http/list-query";

import { prisma } from "@/lib/db";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
} from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { withIdempotency } from "@/lib/idempotency";
import { auditLog } from "@/lib/auth/audit";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import { requireIllnessEnabled } from "@/lib/illness/gate";
import type { Prisma } from "@/generated/prisma/client";
import {
  encryptSymptomText,
  isLinkableEpisode,
  symptomEventCreateSchema,
  symptomEventListQuerySchema,
  toSymptomEventDTO,
} from "@/lib/symptoms/server";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "illness");

  const gate = await requireIllnessEnabled(user.id);
  if (!gate.enabled) return gate.response;

  const sp = request.nextUrl.searchParams;
  const parsed = symptomEventListQuerySchema.safeParse({
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
    definitionId: sp.get("definitionId") ?? undefined,
    episodeId: sp.get("episodeId") ?? undefined,
    limit: sp.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "symptoms.invalid",
    });
  }
  const q = parsed.data;

  const occurredAt: Prisma.DateTimeFilter = {};
  if (q.from) occurredAt.gte = new Date(q.from);
  if (q.to) occurredAt.lte = new Date(q.to);

  const { rows, cap } = await listPage(q.limit, (take) =>
    prisma.symptomEvent.findMany({
      where: {
        userId: user.id,
        ...(q.from || q.to ? { occurredAt } : {}),
        ...(q.definitionId ? { definitionId: q.definitionId } : {}),
        ...(q.episodeId ? { episodeId: q.episodeId } : {}),
      },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take,
    }),
  );

  annotate({
    action: { name: "symptoms.event.list" },
    meta: { count: rows.length, limit: q.limit },
  });

  return apiSuccess({
    events: rows.map(toSymptomEventDTO),
    limit: q.limit,
    // Exact: true only when a row past this page exists. `rows.length ===
    // limit` said true on a page that was exactly full, and the client then
    // asked for a page that held nothing.
    hasMore: cap.truncated,
  });
});

// A retry from a flaky connection re-sends the same `Idempotency-Key` and gets
// the first answer back instead of a second occurrence at the same minute.
export const POST = apiHandler(withIdempotency<[NextRequest]>(postEvent));

async function postEvent(request: NextRequest): Promise<Response> {
  // WRITE, like opening an episode or adding a reading: logging what happened
  // is an admitted delegated write; editing or removing it is MANAGE.
  const { user } = await requireRecordAuth("write", "illness");

  const gate = await requireIllnessEnabled(user.id);
  if (!gate.enabled) return gate.response;

  const parsed = await parseJsonBody(request, symptomEventCreateSchema, {
    maxBytes: 16 * 1024,
    errorCode: "symptoms.invalid",
  });
  if (!parsed.ok) return parsed.error;
  const entry = parsed.data;

  // A hidden definition stays loggable from an older client's cached list;
  // only another account's id (or none) is refused.
  const definition = await prisma.symptomDefinition.findFirst({
    where: { id: entry.definitionId, userId: user.id },
    select: { id: true },
  });
  if (!definition) {
    return apiError("Symptom not found", 404, {
      errorCode: "symptoms.definition.notFound",
    });
  }

  const occurredAt = entry.occurredAt ?? new Date();
  if (
    entry.episodeId &&
    !(await isLinkableEpisode(user.id, entry.episodeId, occurredAt))
  ) {
    return apiError("Episode did not run at that time", 422, {
      errorCode: "symptoms.episode.notOpen",
    });
  }

  const created = await prisma.symptomEvent.create({
    data: {
      userId: user.id,
      definitionId: definition.id,
      occurredAt,
      intensity: entry.intensity,
      noteEncrypted: entry.note ? encryptSymptomText(entry.note) : null,
      episodeId: entry.episodeId ?? null,
    },
  });

  await auditLog("symptoms.event.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      eventId: created.id,
      definitionId: created.definitionId,
      linked: created.episodeId !== null,
    },
  });

  invalidateUserHealthContext(user.id);

  annotate({
    action: {
      name: "symptoms.event.create",
      entity_type: "symptom_event",
      entity_id: created.id,
    },
    meta: { linked: created.episodeId !== null },
  });

  return apiSuccess(toSymptomEventDTO(created), 201);
}

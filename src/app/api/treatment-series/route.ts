/**
 * `GET  /api/treatment-series` — the account's treatment series, open ones
 *                                first, each with its progress resolved.
 * `POST /api/treatment-series` — start one.
 *
 * A series is visits, so it sits in the same section (`profile`) and carries
 * no module gate, for the reason `Encounter` states in the schema. `userId` is
 * narrowed from auth; the `data` object is built field by field.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
} from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { withIdempotency } from "@/lib/idempotency";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import {
  resolveOwnedPractitioner,
  resolveOwnerNotificationContext,
} from "@/lib/encounters/service";
import { actingDomainVisibility } from "@/lib/sharing/acting-domains";
import {
  treatmentSeriesCreateSchema,
  treatmentSeriesListQuerySchema,
} from "@/lib/validations/treatment-series";
import {
  TREATMENT_SERIES_INCLUDE,
  dayToDate,
  orderSeries,
  resolveOwnedEpisode,
  toTreatmentSeriesDTOs,
} from "@/lib/treatment-series/service";

/** More than any one record holds; the list is not paged. */
const MAX_SERIES = 500;

export const GET = apiHandler(async (request: NextRequest) => {
  const { user, grantId } = await requireRecordAuth("read", "profile");

  const params = new URL(request.url).searchParams;
  const parsed = treatmentSeriesListQuerySchema.safeParse({
    episodeId: params.get("episodeId") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "treatment_series.invalid",
    });
  }

  const rows = await prisma.treatmentSeries.findMany({
    where: {
      userId: user.id,
      deletedAt: null,
      ...(parsed.data.episodeId ? { episodeId: parsed.data.episodeId } : {}),
    },
    orderBy: [{ startsOn: "desc" }, { id: "asc" }],
    take: MAX_SERIES,
    include: TREATMENT_SERIES_INCLUDE,
  });
  const [{ timezone }, visible] = await Promise.all([
    resolveOwnerNotificationContext(user.id),
    actingDomainVisibility(prisma, grantId),
  ]);
  const series = orderSeries(
    await toTreatmentSeriesDTOs(prisma, user.id, rows, {
      timezone,
      illnessVisible: visible("illness"),
    }),
  );

  annotate({
    action: { name: "treatment-series.list", entity_type: "treatment_series" },
    meta: { count: series.length },
  });
  return apiSuccess({ series });
});

export const POST = apiHandler(withIdempotency<[NextRequest]>(postSeries));

async function postSeries(request: NextRequest): Promise<Response> {
  const { user, grantId } = await requireRecordAuth("write", "profile");

  const parsed = await parseJsonBody(request, treatmentSeriesCreateSchema, {
    maxBytes: 16 * 1024,
    action: "treatment-series.validation-failed",
    countIssues: true,
    errorCode: "treatment_series.invalid",
  });
  if (!parsed.ok) return parsed.error;
  const entry = parsed.data;

  const created = await prisma.$transaction(async (tx) => {
    for (const practitionerId of [entry.prescriberId, entry.performerId]) {
      if (
        practitionerId &&
        !(await resolveOwnedPractitioner(tx, user.id, practitionerId))
      ) {
        return "unknown-practitioner" as const;
      }
    }
    if (
      entry.episodeId &&
      !(await resolveOwnedEpisode(tx, user.id, entry.episodeId))
    ) {
      return "unknown-episode" as const;
    }
    // Field-by-field — never spread the parsed object whole.
    return tx.treatmentSeries.create({
      data: {
        userId: user.id,
        titleEncrypted: encryptToBytes(entry.title),
        kind: entry.kind,
        plannedSessions: entry.plannedSessions ?? null,
        startsOn: dayToDate(entry.startsOn),
        validUntil: entry.validUntil ? dayToDate(entry.validUntil) : null,
        prescriberId: entry.prescriberId ?? null,
        performerId: entry.performerId ?? null,
        episodeId: entry.episodeId ?? null,
        noteEncrypted: entry.note?.trim()
          ? encryptToBytes(entry.note.trim())
          : null,
      },
      include: TREATMENT_SERIES_INCLUDE,
    });
  });

  if (created === "unknown-practitioner") {
    return apiError("Practitioner not found", 404, {
      errorCode: "treatment_series.practitioner-not-found",
    });
  }
  if (created === "unknown-episode") {
    return apiError("Condition not found", 404, {
      errorCode: "treatment_series.condition-not-found",
    });
  }

  await auditLog("treatment-series.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { seriesId: created.id, plannedSessions: created.plannedSessions },
  });
  invalidateUserHealthContext(user.id);
  annotate({
    action: {
      name: "treatment-series.create",
      entity_type: "treatment_series",
      entity_id: created.id,
    },
    meta: { kind: created.kind },
  });

  const [{ timezone }, visible] = await Promise.all([
    resolveOwnerNotificationContext(user.id),
    actingDomainVisibility(prisma, grantId),
  ]);
  const [dto] = await toTreatmentSeriesDTOs(prisma, user.id, [created], {
    timezone,
    illnessVisible: visible("illness"),
  });
  return apiSuccess(dto, 201);
}

/**
 * `GET    /api/treatment-series/{id}` — one live series with its sessions.
 * `PATCH  /api/treatment-series/{id}` — edit it, end it (`endedOn`), reopen it.
 * `DELETE /api/treatment-series/{id}` — soft-delete it. The sessions stay the
 *          visits they are; they only stop naming the series until a restore.
 *
 * Owner-scoped by fetch-then-guard, at the levels the visit routes use: read
 * to see it, manage to change or remove it.
 */
import { NextRequest } from "next/server";

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { overwriteDetails } from "@/lib/sharing/audit-details";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { toEncounterDTO } from "@/lib/encounters/dto";
import {
  ENCOUNTER_INCLUDE,
  loadEncounterLinksForMany,
  resolveOwnedPractitioner,
  resolveOwnerNotificationContext,
} from "@/lib/encounters/service";
import { actingDomainVisibility } from "@/lib/sharing/acting-domains";
import { treatmentSeriesUpdateSchema } from "@/lib/validations/treatment-series";
import {
  TREATMENT_SERIES_INCLUDE,
  dayToDate,
  loadEncounterSeriesRefs,
  resolveOwnedEpisode,
  toTreatmentSeriesDTOs,
} from "@/lib/treatment-series/service";
import { dateOnlyKey } from "@/lib/tz/date-only";

type RouteParams = { params: Promise<{ id: string }> };

const NOT_FOUND = () => apiError("Treatment series not found", 404);

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user, grantId } = await requireRecordAuth("read", "profile");
    const { id } = await params;
    const row = await prisma.treatmentSeries.findUnique({
      where: { id },
      include: TREATMENT_SERIES_INCLUDE,
    });
    if (!row || row.userId !== user.id || row.deletedAt !== null) {
      return NOT_FOUND();
    }

    const [{ timezone }, visible, visits] = await Promise.all([
      resolveOwnerNotificationContext(user.id),
      actingDomainVisibility(prisma, grantId),
      prisma.encounter.findMany({
        where: { userId: user.id, deletedAt: null, seriesId: id },
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
        include: ENCOUNTER_INCLUDE,
      }),
    ]);
    const [[dto], links, refs] = await Promise.all([
      toTreatmentSeriesDTOs(prisma, user.id, [row], {
        timezone,
        illnessVisible: visible("illness"),
      }),
      loadEncounterLinksForMany(
        prisma,
        user.id,
        visits.map((v) => v.id),
        visible,
      ),
      loadEncounterSeriesRefs(prisma, user.id, visits),
    ]);

    annotate({
      action: {
        name: "treatment-series.read",
        entity_type: "treatment_series",
        entity_id: id,
      },
      meta: { sessions: visits.length },
    });
    return apiSuccess({
      ...dto,
      visits: visits.map((v) => ({
        ...toEncounterDTO(v, links.get(v.id)),
        series: refs.get(v.id) ?? null,
      })),
    });
  },
);

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user, grantId } = await requireRecordAuth("manage", "profile");
    const { id } = await params;
    const existing = await prisma.treatmentSeries.findUnique({ where: { id } });
    if (
      !existing ||
      existing.userId !== user.id ||
      existing.deletedAt !== null
    ) {
      return NOT_FOUND();
    }

    const parsed = await parseJsonBody(request, treatmentSeriesUpdateSchema, {
      maxBytes: 16 * 1024,
      errorCode: "treatment_series.invalid",
    });
    if (!parsed.ok) return parsed.error;
    const entry = parsed.data;

    // The window is judged as it will be after the edit, so moving only the
    // start past an existing end is refused like a create that did so.
    const nextStart = entry.startsOn ?? dateOnlyKey(existing.startsOn);
    const nextValid =
      entry.validUntil !== undefined
        ? entry.validUntil
        : existing.validUntil
          ? dateOnlyKey(existing.validUntil)
          : null;
    if (nextValid !== null && nextValid < nextStart) {
      return apiError("validUntil must be on or after startsOn", 422, {
        errorCode: "treatment_series.invalid",
      });
    }

    const outcome = await prisma.$transaction(async (tx) => {
      const data: Prisma.TreatmentSeriesUpdateInput = {};
      if (entry.title !== undefined) {
        data.titleEncrypted = encryptToBytes(entry.title);
      }
      if (entry.kind !== undefined) data.kind = entry.kind;
      if (entry.plannedSessions !== undefined) {
        data.plannedSessions = entry.plannedSessions;
      }
      if (entry.startsOn !== undefined) {
        data.startsOn = dayToDate(entry.startsOn);
      }
      if (entry.validUntil !== undefined) {
        data.validUntil = entry.validUntil ? dayToDate(entry.validUntil) : null;
      }
      if (entry.endedOn !== undefined) {
        data.endedOn = entry.endedOn ? dayToDate(entry.endedOn) : null;
      }
      if (entry.note !== undefined) {
        data.noteEncrypted = entry.note?.trim()
          ? encryptToBytes(entry.note.trim())
          : null;
      }
      for (const [key, relation] of [
        ["prescriberId", "prescriber"],
        ["performerId", "performer"],
      ] as const) {
        const value = entry[key];
        if (value === undefined) continue;
        if (value === null) {
          data[relation] = { disconnect: true };
          continue;
        }
        const resolved = await resolveOwnedPractitioner(tx, user.id, value);
        if (!resolved) return "unknown-practitioner" as const;
        data[relation] = { connect: { id: resolved.id } };
      }
      if (entry.episodeId !== undefined) {
        if (entry.episodeId === null) {
          data.episode = { disconnect: true };
        } else {
          const episode = await resolveOwnedEpisode(
            tx,
            user.id,
            entry.episodeId,
          );
          if (!episode) return "unknown-episode" as const;
          data.episode = { connect: { id: episode.id } };
        }
      }
      return tx.treatmentSeries.update({
        where: { id },
        data,
        include: TREATMENT_SERIES_INCLUDE,
      });
    });

    if (outcome === "unknown-practitioner") {
      return apiError("Practitioner not found", 404, {
        errorCode: "treatment_series.practitioner-not-found",
      });
    }
    if (outcome === "unknown-episode") {
      return apiError("Condition not found", 404, {
        errorCode: "treatment_series.condition-not-found",
      });
    }

    await auditLog("treatment-series.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        seriesId: id,
        // The title and note are encrypted PHI and stay out of the audit row.
        ...overwriteDetails({
          before: {
            plannedSessions: existing.plannedSessions,
            startsOn: existing.startsOn,
            validUntil: existing.validUntil,
            endedOn: existing.endedOn,
            kind: existing.kind,
          },
          after: {
            plannedSessions: outcome.plannedSessions,
            startsOn: outcome.startsOn,
            validUntil: outcome.validUntil,
            endedOn: outcome.endedOn,
            kind: outcome.kind,
          },
        }),
      },
    });
    invalidateUserHealthContext(user.id);
    annotate({
      action: {
        name: "treatment-series.update",
        entity_type: "treatment_series",
        entity_id: id,
      },
    });

    const [{ timezone }, visible] = await Promise.all([
      resolveOwnerNotificationContext(user.id),
      actingDomainVisibility(prisma, grantId),
    ]);
    const [dto] = await toTreatmentSeriesDTOs(prisma, user.id, [outcome], {
      timezone,
      illnessVisible: visible("illness"),
    });
    return apiSuccess(dto);
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("manage", "profile");
    const { id } = await params;
    const existing = await prisma.treatmentSeries.findUnique({ where: { id } });
    if (!existing || existing.userId !== user.id) return NOT_FOUND();

    // Already tombstoned: deleting twice is a no-op that still succeeds.
    if (existing.deletedAt === null) {
      await prisma.treatmentSeries.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    }

    await auditLog("treatment-series.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { seriesId: id },
    });
    invalidateUserHealthContext(user.id);
    annotate({
      action: {
        name: "treatment-series.delete",
        entity_type: "treatment_series",
        entity_id: id,
      },
    });
    return apiSuccess({ deleted: true });
  },
);

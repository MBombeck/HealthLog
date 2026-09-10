/**
 * `GET    /api/vaccinations/{id}` — one owned, live dose with its links.
 * `PATCH  /api/vaccinations/{id}` — edit it (partial; field-by-field).
 * `DELETE /api/vaccinations/{id}` — soft-delete it.
 *
 * Owner-scoped by fetch-then-guard. `userId` is narrowed from auth; the body
 * never carries it.
 *
 * PATCH deliberately does NOT re-run the booster satisfy matcher. An edit is a
 * correction of a transcription, not a new clinical event, and re-satisfying
 * on edit would make `occurredAt` edits side-effectful in a way no other
 * clinical model here is: fixing a typo in a date would silently push a
 * booster reminder's next due date out. The side effect belongs to the act of
 * logging a dose, which happens once.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { overwriteDetails } from "@/lib/sharing/audit-details";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { vaccinationUpdateSchema } from "@/lib/validations/vaccinations";
import { toVaccinationDTO } from "@/lib/vaccinations/dto";
import {
  VACCINATION_INCLUDE,
  applyVaccinationLinks,
  loadVaccinationDocuments,
  resolveOwnedEncounter,
  resolveOwnedPractitioner,
  resolveSeriesFor,
} from "@/lib/vaccinations/service";
import type { Prisma } from "@/generated/prisma/client";
import { actingDomainVisibility } from "@/lib/sharing/acting-domains";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user, grantId } = await requireRecordAuth("read", "profile");

    const { id } = await params;
    const row = await prisma.vaccinationRecord.findUnique({
      where: { id },
      include: VACCINATION_INCLUDE,
    });
    if (!row || row.userId !== user.id || row.deletedAt !== null) {
      return apiError("Vaccination not found", 404);
    }

    const visible = await actingDomainVisibility(prisma, grantId);
    const [documents, series] = await Promise.all([
      loadVaccinationDocuments(prisma, user.id, id, visible),
      resolveSeriesFor(prisma, user.id),
    ]);

    annotate({
      action: {
        name: "vaccination.record.read",
        entity_type: "vaccination",
        entity_id: id,
      },
    });

    return apiSuccess(toVaccinationDTO(row, series.get(id) ?? [], documents));
  },
);

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user, grantId } = await requireRecordAuth("manage", "profile");

    const { id } = await params;
    const existing = await prisma.vaccinationRecord.findUnique({
      where: { id },
    });
    if (
      !existing ||
      existing.userId !== user.id ||
      existing.deletedAt !== null
    ) {
      return apiError("Vaccination not found", 404);
    }

    const { data: rawBody, error: jsonError } = await safeJson(request, {
      maxBytes: 32 * 1024,
    });
    if (jsonError) return jsonError;

    const parsed = vaccinationUpdateSchema.safeParse(rawBody);
    if (!parsed.success) {
      return returnAllZodIssues(parsed.error, 422, {
        errorCode: "vaccination.invalid",
      });
    }

    const entry = parsed.data;

    // The identity rule is checked against the MERGED row rather than the
    // body, because a PATCH naming only the batch code says nothing about the
    // identity and must not be refused for it — while a PATCH that clears the
    // one arm a record was saved with would leave a dose with no name at all.
    const nextSlug =
      entry.antigenSlug !== undefined
        ? entry.antigenSlug
        : existing.antigenSlug;
    const nextName =
      entry.vaccineName !== undefined
        ? entry.vaccineName
        : existing.vaccineName;
    if (!nextSlug && !nextName) {
      return apiError(
        "A dose keeps a name: pick one from the catalogue or type what the record says",
        422,
        { errorCode: "vaccination.identity-required" },
      );
    }

    const outcome = await prisma.$transaction(async (tx) => {
      if (entry.practitionerId) {
        const owned = await resolveOwnedPractitioner(
          tx,
          user.id,
          entry.practitionerId,
        );
        if (!owned) return "unknown-practitioner" as const;
      }
      if (entry.encounterId) {
        const owned = await resolveOwnedEncounter(
          tx,
          user.id,
          entry.encounterId,
        );
        if (!owned) return "unknown-encounter" as const;
      }

      const data: Prisma.VaccinationRecordUpdateInput = {};
      if (entry.occurredAt !== undefined) {
        data.occurredAt = new Date(entry.occurredAt);
      }
      if (entry.antigenSlug !== undefined) data.antigenSlug = entry.antigenSlug;
      if (entry.vaccineName !== undefined) data.vaccineName = entry.vaccineName;
      if (entry.doseNumber !== undefined) data.doseNumber = entry.doseNumber;
      if (entry.seriesDoses !== undefined) data.seriesDoses = entry.seriesDoses;
      if (entry.lotNumber !== undefined) data.lotNumber = entry.lotNumber;
      if (entry.site !== undefined) data.site = entry.site;
      if (entry.note !== undefined) {
        data.noteEncrypted = entry.note ? encryptToBytes(entry.note) : null;
      }
      if (entry.practitionerId !== undefined) {
        data.practitioner = entry.practitionerId
          ? { connect: { id: entry.practitionerId } }
          : { disconnect: true };
      }
      if (entry.encounterId !== undefined) {
        data.encounter = entry.encounterId
          ? { connect: { id: entry.encounterId } }
          : { disconnect: true };
      }

      const updated = await tx.vaccinationRecord.update({
        where: { id },
        data,
      });
      await applyVaccinationLinks(tx, user.id, id, entry.documentIds);
      return { updated };
    });

    if (outcome === "unknown-practitioner") {
      return apiError("Practitioner not found", 404, {
        errorCode: "vaccination.practitioner-not-found",
      });
    }
    if (outcome === "unknown-encounter") {
      return apiError("Visit not found", 404, {
        errorCode: "vaccination.encounter-not-found",
      });
    }

    const row = await prisma.vaccinationRecord.findUniqueOrThrow({
      where: { id },
      include: VACCINATION_INCLUDE,
    });
    const visible = await actingDomainVisibility(prisma, grantId);
    const [documents, series] = await Promise.all([
      loadVaccinationDocuments(prisma, user.id, id, visible),
      resolveSeriesFor(prisma, user.id),
    ]);

    await auditLog("vaccination.record.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        vaccinationId: id,
        // The note is deliberately absent: encrypted PHI, and the audit table
        // is not a second copy of the record.
        ...overwriteDetails({
          before: {
            occurredAt: existing.occurredAt,
            antigenSlug: existing.antigenSlug,
            doseNumber: existing.doseNumber,
            practitionerId: existing.practitionerId,
            encounterId: existing.encounterId,
          },
          after: {
            occurredAt: outcome.updated.occurredAt,
            antigenSlug: outcome.updated.antigenSlug,
            doseNumber: outcome.updated.doseNumber,
            practitionerId: outcome.updated.practitionerId,
            encounterId: outcome.updated.encounterId,
          },
        }),
      },
    });

    annotate({
      action: {
        name: "vaccination.record.update",
        entity_type: "vaccination",
        entity_id: id,
      },
      meta: { antigen_slug: row.antigenSlug ?? "free-text" },
    });

    return apiSuccess(toVaccinationDTO(row, series.get(id) ?? [], documents));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("manage", "profile");

    const { id } = await params;
    const existing = await prisma.vaccinationRecord.findUnique({
      where: { id },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Vaccination not found", 404);
    }

    // Already tombstoned: deleting twice is a no-op that still succeeds.
    //
    // A booster reminder this dose satisfied is deliberately NOT re-opened.
    // The reminder belongs to the person's preventive-care list and outlives
    // the record; rewinding its due date because a transcription was tidied up
    // would turn a correction into a nudge.
    if (existing.deletedAt === null) {
      await prisma.vaccinationRecord.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
    }

    await auditLog("vaccination.record.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        vaccinationId: id,
        occurredAt: existing.occurredAt.toISOString(),
        antigenSlug: existing.antigenSlug,
      },
    });

    annotate({
      action: {
        name: "vaccination.record.delete",
        entity_type: "vaccination",
        entity_id: id,
      },
    });

    return apiSuccess({ deleted: true });
  },
);

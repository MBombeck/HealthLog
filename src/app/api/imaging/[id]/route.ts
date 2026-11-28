/**
 * `GET    /api/imaging/{id}` — one exam with its filed documents.
 * `PATCH  /api/imaging/{id}` — edit it (partial; `null` or "" clears a text).
 * `DELETE /api/imaging/{id}` — remove it. The filed documents stay in the
 *                              vault; only the links go.
 *
 * Owner-scoped by fetch-then-guard: another record's id is a 404. MANAGE on a
 * shared record for the writes. Free text is never logged or audited.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  destroyedDetails,
  overwriteDetails,
} from "@/lib/sharing/audit-details";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { actingDomainVisibility } from "@/lib/sharing/acting-domains";
import type { Prisma } from "@/generated/prisma/client";
import { imagingExamUpdateSchema } from "@/lib/imaging/shared";
import {
  IMAGING_EXAM_INCLUDE,
  applyImagingExamDocuments,
  examDayAtUtcMidnight,
  sealImagingText,
  toImagingExamDTO,
} from "@/lib/imaging/server";

type RouteParams = { params: Promise<{ id: string }> };

function notFound(): Response {
  return apiError("Imaging exam not found", 404, {
    errorCode: "imaging.notFound",
  });
}

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user, grantId } = await requireRecordAuth("read", "labs");
    const { id } = await params;

    const row = await prisma.imagingExam.findFirst({
      where: { id, userId: user.id },
      include: IMAGING_EXAM_INCLUDE,
    });
    if (!row) return notFound();

    annotate({
      action: {
        name: "imaging.exam.read",
        entity_type: "imaging-exam",
        entity_id: id,
      },
    });
    const visible = await actingDomainVisibility(prisma, grantId);
    return apiSuccess(toImagingExamDTO(row, visible));
  },
);

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user, grantId } = await requireRecordAuth("manage", "labs");
    const { id } = await params;

    const existing = await prisma.imagingExam.findFirst({
      where: { id, userId: user.id },
      select: { id: true, modality: true, performedAt: true, side: true },
    });
    if (!existing) return notFound();

    const parsed = await parseJsonBody(request, imagingExamUpdateSchema, {
      maxBytes: 32 * 1024,
      errorCode: "imaging.invalid",
    });
    if (!parsed.ok) return parsed.error;
    const entry = parsed.data;

    const data: Prisma.ImagingExamUpdateInput = {};
    if (entry.modality !== undefined) data.modality = entry.modality;
    if (entry.performedAt !== undefined) {
      data.performedAt = examDayAtUtcMidnight(entry.performedAt);
    }
    if (entry.side !== undefined) data.side = entry.side;
    const bodyPart = sealImagingText(entry.bodyPart);
    if (bodyPart !== undefined) data.bodyPartEncrypted = bodyPart;
    const facility = sealImagingText(entry.facility);
    if (facility !== undefined) data.facilityEncrypted = facility;
    const doctor = sealImagingText(entry.requestingDoctor);
    if (doctor !== undefined) data.requestingDoctorEncrypted = doctor;
    const conclusion = sealImagingText(entry.conclusion);
    if (conclusion !== undefined) data.conclusionEncrypted = conclusion;

    const row = await prisma.$transaction(async (tx) => {
      await tx.imagingExam.update({ where: { id }, data });
      await applyImagingExamDocuments(tx, user.id, id, entry.documentIds);
      return tx.imagingExam.findUniqueOrThrow({
        where: { id },
        include: IMAGING_EXAM_INCLUDE,
      });
    });

    await auditLog("imaging.exam.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        examId: id,
        ...overwriteDetails({
          before: {
            modality: existing.modality,
            performedAt: existing.performedAt,
            side: existing.side,
          },
          after: {
            modality: row.modality,
            performedAt: row.performedAt,
            side: row.side,
          },
        }),
      },
    });

    annotate({
      action: {
        name: "imaging.exam.update",
        entity_type: "imaging-exam",
        entity_id: id,
      },
      meta: { documents_replaced: entry.documentIds !== undefined },
    });

    const visible = await actingDomainVisibility(prisma, grantId);
    return apiSuccess(toImagingExamDTO(row, visible));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("manage", "labs");
    const { id } = await params;

    const existing = await prisma.imagingExam.findFirst({
      where: { id, userId: user.id },
      select: { id: true, modality: true, performedAt: true },
    });
    if (!existing) return notFound();

    // The links cascade; the documents themselves stay in the vault.
    await prisma.imagingExam.delete({ where: { id } });

    await auditLog("imaging.exam.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        examId: id,
        ...destroyedDetails({
          model: "ImagingExam",
          id,
          label: existing.modality,
          effectiveAt: existing.performedAt.toISOString(),
        }),
      },
    });

    annotate({
      action: {
        name: "imaging.exam.delete",
        entity_type: "imaging-exam",
        entity_id: id,
      },
    });

    return apiSuccess({ deleted: true });
  },
);

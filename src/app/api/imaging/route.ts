/**
 * `GET  /api/imaging` — the record's imaging exams, newest first.
 * `POST /api/imaging` — record one exam, optionally with its report and
 *                       pictures from the document vault.
 *
 * Classified `labs`: an imaging exam is a finding, read in the same section as
 * lab results. Cookie or wildcard token only (no narrow scope). The module
 * gate governs the surfaces, not these routes, so a restore keeps working
 * and re-enabling finds every row intact (the `vaccinations` posture).
 *
 * `userId` is narrowed from auth; the `data` object is built field by field.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { withIdempotency } from "@/lib/idempotency";
import { actingDomainVisibility } from "@/lib/sharing/acting-domains";
import {
  imagingExamCreateSchema,
  type ImagingExamListDTO,
} from "@/lib/imaging/shared";
import {
  IMAGING_EXAM_INCLUDE,
  applyImagingExamDocuments,
  examDayAtUtcMidnight,
  sealImagingText,
  toImagingExamDTO,
} from "@/lib/imaging/server";

/** A lifetime of exams is a short list; the cap is a safety bound. */
const LIST_CAP = 500;

export const GET = apiHandler(async () => {
  const { user, grantId } = await requireRecordAuth("read", "labs");

  const rows = await prisma.imagingExam.findMany({
    where: { userId: user.id },
    orderBy: [{ performedAt: "desc" }, { id: "desc" }],
    take: LIST_CAP,
    include: IMAGING_EXAM_INCLUDE,
  });
  const visible = await actingDomainVisibility(prisma, grantId);

  annotate({
    action: { name: "imaging.exam.list", entity_type: "imaging-exam" },
    meta: { count: rows.length },
  });

  const body: ImagingExamListDTO = {
    exams: rows.map((row) => toImagingExamDTO(row, visible)),
  };
  return apiSuccess(body);
});

// A double-tap on "save" must not record the same exam twice.
export const POST = apiHandler(withIdempotency<[NextRequest]>(postExam));

async function postExam(request: NextRequest): Promise<Response> {
  const { user, grantId } = await requireRecordAuth("write", "labs");

  const parsed = await parseJsonBody(request, imagingExamCreateSchema, {
    maxBytes: 32 * 1024,
    action: "imaging.exam.validation-failed",
    countIssues: true,
    errorCode: "imaging.invalid",
  });
  if (!parsed.ok) return parsed.error;
  const entry = parsed.data;

  const { row, unknown } = await prisma.$transaction(async (tx) => {
    // Field by field, never the parsed object whole.
    const created = await tx.imagingExam.create({
      data: {
        userId: user.id,
        modality: entry.modality,
        performedAt: examDayAtUtcMidnight(entry.performedAt),
        side: entry.side ?? null,
        bodyPartEncrypted: sealImagingText(entry.bodyPart) ?? null,
        facilityEncrypted: sealImagingText(entry.facility) ?? null,
        requestingDoctorEncrypted:
          sealImagingText(entry.requestingDoctor) ?? null,
        conclusionEncrypted: sealImagingText(entry.conclusion) ?? null,
      },
      select: { id: true },
    });
    const unknownIds = await applyImagingExamDocuments(
      tx,
      user.id,
      created.id,
      entry.documentIds,
    );
    return {
      row: await tx.imagingExam.findUniqueOrThrow({
        where: { id: created.id },
        include: IMAGING_EXAM_INCLUDE,
      }),
      unknown: unknownIds,
    };
  });

  await auditLog("imaging.exam.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      examId: row.id,
      modality: row.modality,
      performedAt: row.performedAt.toISOString(),
      // The free text is deliberately absent: sealed PHI, and the audit
      // table is not a second copy of the record.
    },
  });

  annotate({
    action: {
      name: "imaging.exam.create",
      entity_type: "imaging-exam",
      entity_id: row.id,
    },
    meta: {
      modality: row.modality,
      linked_documents: row.documentLinks.length,
      unknown_documents: unknown.length,
    },
  });

  const visible = await actingDomainVisibility(prisma, grantId);
  return apiSuccess(toImagingExamDTO(row, visible), 201);
}

/**
 * `GET  /api/family-history` — newest-first list of the account's family-history
 *                             entries.
 * `POST /api/family-history` — create one condition-by-relative record.
 *
 * A structured FamilyMemberHistory-style RECORD, patient-reported — never a
 * clinical diagnosis the app asserts. `userId` is narrowed from auth and fed
 * to the Prisma `where`; it is never a body field. The `data` object is built
 * field-by-field (no mass assignment); the free-text `note` is encrypted at
 * rest.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
} from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { withIdempotency } from "@/lib/idempotency";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import {
  familyHistoryCreateSchema,
  familyHistoryListQuerySchema,
} from "@/lib/validations/family-history";
import { toFamilyHistoryEntryDTO } from "@/lib/records/dto";
import { apiListSuccess } from "@/lib/api/list-cap";
import { listPage } from "@/lib/http/list-query";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "profile");

  const params = new URL(request.url).searchParams;
  const parsed = familyHistoryListQuerySchema.safeParse({
    limit: params.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "familyHistory.invalid",
    });
  }

  const limit = parsed.data.limit ?? 100;
  const { rows, cap } = await listPage(limit, (take) =>
    prisma.familyHistoryEntry.findMany({
      where: { userId: user.id, deletedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
    }),
  );

  annotate({
    action: { name: "family-history.list", entity_type: "family_history" },
    meta: { count: rows.length },
  });

  return apiListSuccess(rows.map(toFamilyHistoryEntryDTO), cap);
});

export const POST = apiHandler(
  withIdempotency<[NextRequest]>(postFamilyHistory),
);

async function postFamilyHistory(request: NextRequest): Promise<Response> {
  // v1.37.0 — MANAGE, and reachable. Third-party data by design, admitted on
  // the same reasoning the read arm was: it is the record's own health
  // background, and the surface is Settings → Anamnese inside the record
  // (`src/components/settings/record-anamnesis-section.tsx`).
  //
  // This arm carried an extra reason to wait, and that reason is now answered
  // where it can be. The row describes the record subject's RELATIVES, so it
  // is the one admitted write where third-party health information is present
  // by design — and frequently the delegate IS that relative, asserting a
  // condition about themselves into somebody else's record. No route comment
  // can say that to the person filling the form; the card above the form says
  // it (`recordSharing.anamnesis.relativeNote`).
  const { user } = await requireRecordAuth("manage", "profile");

  const parsed = await parseJsonBody(request, familyHistoryCreateSchema, {
    maxBytes: 16 * 1024,
    action: "family-history.validation-failed",
    countIssues: true,
    errorCode: "familyHistory.invalid",
  });
  if (!parsed.ok) return parsed.error;

  const entry = parsed.data;

  // Field-by-field — never spread the parsed object whole.
  const created = await prisma.familyHistoryEntry.create({
    data: {
      userId: user.id,
      relationship: entry.relationship,
      condition: entry.condition,
      ageAtOnset: entry.ageAtOnset ?? null,
      notesEncrypted: entry.note ? encryptToBytes(entry.note) : null,
    },
  });

  await auditLog("family-history.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { entryId: created.id, relationship: created.relationship },
  });

  annotate({
    action: {
      name: "family-history.create",
      entity_type: "family_history",
      entity_id: created.id,
    },
    meta: { relationship: created.relationship },
  });

  return apiSuccess(toFamilyHistoryEntryDTO(created), 201);
}

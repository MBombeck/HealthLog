/**
 * v1.25 — review-then-confirm: commit the user's decisions.
 *
 * The ONLY write path out of the staging area. The user approves or rejects
 * each staged fact; an approved fact is committed to its structured store
 * (labs / conditions / medications) through the normal field-by-field create.
 * Nothing landed in the structured stores until this call — that is the
 * structural guarantee that the app never "decided" anything.
 *
 * Fail-closed: a fact still flagged `needsReview` (it scored below the
 * confidence floor and was never edited) CANNOT be approved — it is reported
 * back as `needsReview` so the user edits it first. A per-fact commit miss
 * (e.g. a numeric observation with no unit) is reported per-fact and never
 * fails the whole batch. `userId` is narrowed from the session; every fact id
 * is re-scoped to the document + the caller.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { commitApprovedFact, FactCommitError } from "@/lib/documents/commit";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { withIdempotency } from "@/lib/idempotency";
import { inboundConfirmSchema } from "@/lib/validations/inbound-documents";

type RouteParams = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

async function confirmDocument(
  request: NextRequest,
  { params }: RouteParams,
): Promise<Response> {
  const { user } = await requireAuth();
  const gate = await requireModuleEnabled(user.id, "inboundDocuments");
  if (!gate.enabled) return gate.response;

  const { id } = await params;

  const document = await prisma.inboundDocument.findFirst({
    where: { id, userId: user.id, deletedAt: null },
    // The two dates date a value that states none of its own.
    select: { id: true, reportDate: true, documentDate: true },
  });
  if (!document) {
    return apiError("Document not found", 404, {
      errorCode: "documents.inbound.notFound",
    });
  }

  const parsed = await parseJsonBody(request, inboundConfirmSchema, {
    maxBytes: 64 * 1024,
  });
  if (!parsed.ok) return parsed.error;

  const approved: { factId: string; recordType: string; recordId: string }[] =
    [];
  const rejected: string[] = [];
  const needsReview: string[] = [];
  const failed: { factId: string; reason: string }[] = [];

  for (const decision of parsed.data.decisions) {
    const fact = await prisma.extractedFact.findFirst({
      where: {
        id: decision.factId,
        documentId: document.id,
        userId: user.id,
        status: "PENDING",
      },
    });
    if (!fact) {
      // Already decided, or not owned/known — skip silently as a no-op.
      continue;
    }

    if (decision.action === "reject") {
      await prisma.extractedFact.update({
        where: { id: fact.id },
        data: { status: "REJECTED" },
      });
      rejected.push(fact.id);
      continue;
    }

    // approve — fail closed on a low-confidence fact the user never edited.
    if (fact.needsReview) {
      needsReview.push(fact.id);
      continue;
    }

    try {
      // v1.43 — an OBSERVATION may name the marker the person chose
      // on the review screen; the label is then remembered as its alias.
      const ref = await commitApprovedFact(
        user.id,
        fact,
        {
          biomarkerId: decision.biomarkerId,
          rememberAlias: decision.rememberAlias,
        },
        document,
      );
      await prisma.extractedFact.update({
        where: { id: fact.id },
        data: {
          status: "APPROVED",
          committedRecordId: ref.recordId,
          committedRecordType: ref.recordType,
        },
      });
      approved.push({
        factId: fact.id,
        recordType: ref.recordType,
        recordId: ref.recordId,
      });
    } catch (err) {
      if (err instanceof FactCommitError) {
        failed.push({ factId: fact.id, reason: err.code });
        continue;
      }
      throw err;
    }
  }

  // When every fact has been decided, the document is fully reviewed.
  const remainingPending = await prisma.extractedFact.count({
    where: { documentId: document.id, status: "PENDING" },
  });
  if (remainingPending === 0) {
    await prisma.inboundDocument.update({
      where: { id: document.id },
      data: { status: "CONFIRMED" },
    });
  }

  await auditLog("documents.inbound.confirm", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      documentId: document.id,
      approved: approved.length,
      rejected: rejected.length,
      failed: failed.length,
    },
  });

  annotate({
    action: { name: "documents.inbound.confirm" },
    meta: {
      documentId: document.id,
      approved: approved.length,
      rejected: rejected.length,
      needsReview: needsReview.length,
      failed: failed.length,
    },
  });

  return apiSuccess({ approved, rejected, needsReview, failed });
}

export const POST = apiHandler(
  withIdempotency<[NextRequest, RouteParams]>(confirmDocument),
);

/**
 * Read a stored lab report's values without a model, for review.
 *
 * POST /api/documents/inbound/{id}/lab-values — reads the table rows of the
 * document's stored text (its content index: the PDF text layer, OCR on this
 * server, or an earlier transcription) by rule (`labValuesFromText`) and
 * stages them PENDING, replacing what an earlier read staged, for the same
 * review screen the AI extraction fills. Nothing reaches the record here; the
 * confirm route stays the only write.
 *
 * No AI capability is asked for, on purpose: this is reading data, not model
 * work, so it answers with AI switched off, with "local only", and with no
 * provider configured. Owner-scoped, documents and labs modules on, the same
 * refusals the extraction has (a confirmed document, a partly confirmed one,
 * and the re-check under the row lock while staging).
 */
import { NextRequest } from "next/server";

import { documentAiJobFailures } from "@/lib/ai/job-failure/read";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { loadOwnedDocument } from "@/lib/documents/ai-route-support";
import {
  stageExtraction,
  StagingRefused,
} from "@/lib/documents/ai-runs/extract-run";
import { outcomeResponse } from "@/lib/documents/ai-runs/http";
import {
  labValuesFromText,
  storedTextForLabValues,
} from "@/lib/documents/local-lab-values";
import {
  markerIndexForFacts,
  serialiseDocumentDetail,
} from "@/lib/documents/store";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

/** Reads per account and minute. Each is a parse of stored text, no model. */
const LAB_VALUES_RATE_LIMIT = 30;
const LAB_VALUES_WINDOW_MS = 60_000;

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("guardian", "documents");

    const documents = await requireModuleEnabled(user.id, "inboundDocuments");
    if (!documents.enabled) return documents.response;
    const labs = await requireModuleEnabled(user.id, "labs");
    if (!labs.enabled) return labs.response;

    const rl = await checkRateLimit(
      `documents:lab-values:${user.id}`,
      LAB_VALUES_RATE_LIMIT,
      LAB_VALUES_WINDOW_MS,
    );
    if (!rl.allowed) {
      const response = apiError("Too many requests", 429, {
        errorCode: "documents.inbound.rateLimited",
        retryAt: new Date(rl.resetAt).toISOString(),
      });
      for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
        response.headers.set(k, v);
      }
      return response;
    }

    const { id } = await params;
    const document = await loadOwnedDocument(user.id, id);
    if (!document) {
      return apiError("Document not found", 404, {
        errorCode: "documents.inbound.notFound",
      });
    }
    if (document.status === "CONFIRMED") {
      return apiError("This document has already been confirmed.", 422, {
        errorCode: "documents.inbound.alreadyConfirmed",
      });
    }
    // Restaging would replace approved facts with pending ones that could be
    // approved a second time; the staging asks again under its row lock.
    const approvedCount = await prisma.extractedFact.count({
      where: { documentId: document.id, userId: user.id, status: "APPROVED" },
    });
    if (approvedCount > 0) {
      return apiError(
        "Some facts from this document are already confirmed. Finish reviewing or discard it before reading it again.",
        409,
        { errorCode: "documents.inbound.alreadyPartlyConfirmed" },
      );
    }

    const stored = await storedTextForLabValues(user.id, document.id);
    if (!stored) {
      return apiError("This document has no stored text to read yet.", 422, {
        errorCode: "documents.inbound.notIndexed",
      });
    }

    const result = labValuesFromText(stored.text, { ocr: stored.ocr });
    let staged: Awaited<ReturnType<typeof stageExtraction>>;
    try {
      staged = await stageExtraction(
        document.id,
        user.id,
        result,
        result.incomplete,
      );
    } catch (err) {
      if (err instanceof StagingRefused) return outcomeResponse(err.outcome);
      throw err;
    }

    annotate({
      action: { name: "documents.labValues.staged" },
      meta: {
        documentId: document.id,
        facts: result.facts.length,
        needsReview: result.facts.filter((f) => f.needsReview).length,
        ocr: stored.ocr,
        incomplete: result.incomplete,
        trigger: "request",
      },
    });
    await auditLog("documents.inbound.extract", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        documentId: document.id,
        facts: result.facts.length,
        mode: "rules",
      },
    });

    return apiSuccess(
      serialiseDocumentDetail(
        staged,
        staged.facts,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        await markerIndexForFacts(user.id, staged.facts),
        await documentAiJobFailures(user.id, staged.id),
      ),
    );
  },
);

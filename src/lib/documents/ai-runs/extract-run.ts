/**
 * Fact extraction from a stored document: the body both the synchronous
 * extract route and the background run execute, so the two paths cannot
 * drift.
 *
 * One extraction over text the browser read, the document's own stored text,
 * or the stored original, split into reads the way the lab scan splits a
 * report (`planInboundReads`: a PDF a page at a time, text in parts, as many
 * reads as the run's deadline allows), against a reservation the caller
 * already took. Every read after the first is reserved on its own, and the
 * whole is settled here against what the provider reported. The facts land
 * PENDING for the mandatory review step; the confirm route stays the only
 * write into the person's record.
 *
 * Staging re-checks the document under a row lock. The route refuses a
 * confirmed or partly confirmed document before it charges anything, but a
 * background read can take minutes, and a review the person finishes in the
 * meantime must never have its approved facts replaced by fresh PENDING ones
 * (which could then be approved a second time). So the staging transaction
 * locks the document row, asks again, and refuses with the route's own code.
 */
import type { Buffer } from "node:buffer";

import type { ProviderChainType } from "@/lib/ai/provider-chain";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import {
  refundDocumentAiSlot,
  type LoadedDocument,
} from "@/lib/documents/ai-route-support";
import {
  planInboundReads,
  runInboundExtraction,
  type InboundExtractionResult,
  type InboundReadSource,
} from "@/lib/documents/extract";
import {
  OCR_EXTRACT_MODEL_CALLS,
  type OcrSchedule,
} from "@/lib/documents/ocr-plan";
import { OcrExtractError } from "@/lib/documents/ocr-read";
import {
  decryptDocumentContent,
  encryptFactData,
  encryptFactProvenance,
} from "@/lib/documents/store";
import { detectOcrMimeType } from "@/lib/labs/ocr-upload";
import { annotate } from "@/lib/logging/context";
import { dateOnlyAtNoonUtc } from "@/lib/tz/date-only";

import { refusalAsFailure } from "./http";
import { meteredReadBudget } from "./metered-budget";
import {
  runFailure,
  unreadableDocument,
  type DocumentTextPick,
  type DocumentVisionPick,
  type RunOrigin,
} from "./run-support";
import {
  AI_RUN_ERROR_CODES,
  type AiRunBudget,
  type AiRunOutcome,
} from "./types";

/**
 * What the extraction reads: text the browser read (`text`), the document's
 * own content index (`stored`, loaded by the caller), or the stored original
 * (`vision`).
 */
export type DocumentExtractInput =
  | {
      mode: "text" | "stored";
      text: string;
      pick: DocumentTextPick;
      budget: AiRunBudget;
    }
  | { mode: "vision"; pick: DocumentVisionPick; budget: AiRunBudget };

/** The staged document with its facts, for the route's detail body. */
export type StagedDocument = Awaited<ReturnType<typeof stageExtraction>>;

/** A finished extraction: the staged document, and whether part of it was not read. */
export interface DocumentExtraction {
  document: StagedDocument;
  /** Part of the document's facts may be missing (`InboundExtractionResult.incomplete`, or text / pages planned out of the reads). */
  incomplete: boolean;
}

class StagingRefused extends Error {
  constructor(readonly outcome: AiRunOutcome<never>) {
    super("staging refused");
  }
}

/**
 * Replace the document's staged facts and flip it to EXTRACTED in one
 * transaction, after locking the row and asking again whether it may be.
 *
 * Re-extraction is allowed only when NO fact is APPROVED and the document is
 * not CONFIRMED, so clearing every prior staged fact here can never drop an
 * approved row or sever a committed-record provenance link: the only facts
 * present are PENDING / REJECTED leftovers from an earlier run.
 */
async function stageExtraction(
  documentId: string,
  userId: string,
  result: InboundExtractionResult,
) {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status
        FROM inbound_documents
       WHERE id = ${documentId} AND user_id = ${userId} AND deleted_at IS NULL
       FOR UPDATE`;
    const status = locked[0]?.status;
    if (!status) {
      throw new StagingRefused(
        runFailure({
          status: 404,
          message: "Document not found",
          errorCode: "documents.inbound.notFound",
        }),
      );
    }
    if (status === "CONFIRMED") {
      throw new StagingRefused(
        runFailure({
          status: 422,
          message: "This document has already been confirmed.",
          errorCode: "documents.inbound.alreadyConfirmed",
        }),
      );
    }
    const approved = await tx.extractedFact.count({
      where: { documentId, userId, status: "APPROVED" },
    });
    if (approved > 0) {
      throw new StagingRefused(
        runFailure({
          status: 409,
          message:
            "Some facts from this document are already confirmed. Finish reviewing or discard it before extracting again.",
          errorCode: "documents.inbound.alreadyPartlyConfirmed",
        }),
      );
    }
    await tx.extractedFact.deleteMany({ where: { documentId, userId } });
    await tx.inboundDocument.update({
      where: { id: documentId },
      data: {
        status: "EXTRACTED",
        providerType: result.providerType,
        reportDate: result.reportDate
          ? dateOnlyAtNoonUtc(result.reportDate)
          : null,
        facts: {
          create: result.facts.map((f) => ({
            userId,
            factType: f.factType,
            status: "PENDING" as const,
            confidence: f.confidence,
            needsReview: f.needsReview,
            dataEncrypted: encryptFactData(f.data),
            provenanceEncrypted: encryptFactProvenance(f.provenance),
          })),
        },
      },
    });
    return tx.inboundDocument.findUniqueOrThrow({
      where: { id: documentId },
      include: { facts: { orderBy: { createdAt: "asc" } } },
    });
  });
}

/**
 * The stored original as a read source: decrypted, its MIME re-derived from
 * the bytes (never the stored label). Every miss happens before the dispatch.
 */
function visionSource(
  document: LoadedDocument,
  pick: DocumentVisionPick,
): InboundReadSource | AiRunOutcome<never> {
  let buffer: Buffer;
  try {
    buffer = decryptDocumentContent(
      document.contentEncrypted,
      document.contentCodec,
    );
  } catch {
    return runFailure({
      status: 422,
      message: "Couldn't read the stored document.",
      errorCode: "documents.inbound.extractFailed",
    });
  }
  const mime = detectOcrMimeType(buffer);
  if (!mime) {
    return runFailure({
      status: 422,
      message: "This document can't be scanned. Use local OCR (text mode).",
      errorCode: "documents.inbound.fileType",
    });
  }
  return {
    mode: "vision",
    bytes: buffer,
    mime,
    pdfSupported: pick.pdfSupported,
  };
}

/** A PDF this provider can read neither rendered nor whole. */
const pdfUnreadable = (): AiRunOutcome<never> =>
  runFailure({
    status: 422,
    message:
      "PDF scanning needs a Claude vision provider; use local OCR instead.",
    errorCode: "documents.inbound.pdfNeedsAnthropic",
  });

/**
 * The answer for an extraction no read produced anything from. Honest about
 * why: an answer cut at the provider's output limit is not an unreadable copy,
 * and a read the budget or the record's AI settings stopped says so.
 */
function extractionFailure(err: OcrExtractError): AiRunOutcome<never> {
  switch (err.reason) {
    case "output_limit":
      return runFailure({
        status: 422,
        message:
          "The AI provider stopped at its output limit before it returned a fact.",
        errorCode: "documents.inbound.outputLimit",
      });
    case "budget":
      return runFailure({
        status: 429,
        message: "Your AI usage budget for today is reached.",
        errorCode: "documents.inbound.budgetExceeded",
      });
    case "unavailable": {
      // The wire's own refusal (the client reads its code: consent, the
      // operator's switch, the module).
      const refused = err.refusal ? refusalAsFailure(err.refusal) : null;
      if (refused) return runFailure(refused);
      return runFailure({
        status: 500,
        message: "The background read failed.",
        errorCode: AI_RUN_ERROR_CODES.failed,
      });
    }
    case "error":
      // The check before the first read failed itself.
      return runFailure({
        status: 500,
        message: "The background read failed.",
        errorCode: AI_RUN_ERROR_CODES.failed,
      });
    default:
      return unreadableDocument(true);
  }
}

/** Extract and stage facts from one owned document. The caller authorised and charged it. */
export async function executeDocumentExtract(args: {
  userId: string;
  document: LoadedDocument;
  input: DocumentExtractInput;
  origin: RunOrigin;
  /** The run's deadline; absent, the reads are planned without one. */
  schedule?: OcrSchedule;
}): Promise<AiRunOutcome<DocumentExtraction>> {
  const { userId, document, input, origin, schedule } = args;
  const { pick, budget } = input;
  const servedBy = pick.entry.providerType as ProviderChainType;
  const { meter, reserveRead, settle } = meteredReadBudget(
    userId,
    budget,
    servedBy,
  );
  // A miss before any provider dispatch: the reservation and the slot go back.
  const refused = async (outcome: AiRunOutcome<never>) => {
    await settle(false);
    await refundDocumentAiSlot(userId);
    return outcome;
  };

  let source: InboundReadSource;
  if (input.mode === "vision") {
    const prepared = visionSource(document, input.pick);
    if ("ok" in prepared) return refused(prepared);
    source = prepared;
  } else {
    source = { mode: "text", text: input.text };
  }
  const plan = await planInboundReads(source, schedule);
  if (!plan.ok) return refused(pdfUnreadable());
  await schedule?.arm(plan.args.chunks.length * OCR_EXTRACT_MODEL_CALLS);

  let result: InboundExtractionResult;
  try {
    result = await runInboundExtraction({
      userId,
      provider: pick.entry.instance,
      providerType: pick.providerType,
      ...plan.args,
      meter,
      reserveRead,
    });
  } catch (err) {
    // Charged for the calls that were made, a failed read included.
    await settle(false);
    if (err instanceof OcrExtractError) return extractionFailure(err);
    annotate({
      action: { name: "documents.inbound.extractFailed" },
      meta: { reason: "provider_error", mode: input.mode },
    });
    return unreadableDocument(false);
  }
  await settle(true);

  let staged: StagedDocument;
  try {
    staged = await stageExtraction(document.id, userId, result);
  } catch (err) {
    if (!(err instanceof StagingRefused)) {
      // The reservation is already settled for the call that was made; a
      // write that failed is answered as the route always answered it.
      annotate({
        action: { name: "documents.inbound.extractFailed" },
        meta: { reason: "staging_error", mode: input.mode },
      });
      return unreadableDocument(false);
    }
    annotate({
      action: { name: "documents.inbound.extractRefusedAtStaging" },
      meta: {
        documentId: document.id,
        errorCode: err.outcome.ok ? null : err.outcome.errorCode,
      },
    });
    return err.outcome;
  }

  await auditLog("documents.inbound.extract", {
    userId,
    ...(origin.worker ? { actorUserId: userId } : {}),
    ipAddress: origin.ipAddress,
    details: {
      documentId: document.id,
      facts: staged.facts.length,
      mode: input.mode,
    },
  });
  return {
    ok: true,
    data: { document: staged, incomplete: result.incomplete || plan.partial },
  };
}

/**
 * "Read with AI" for one stored document: the body both the synchronous index
 * route and the background run execute, so the two paths cannot drift.
 *
 * Vision mode decrypts the stored original, makes one provider transcription
 * call against a reservation the caller already took, and indexes the text.
 * Text mode indexes text the browser read on the device (no provider call).
 * Both then record the attempt, lift an import's hold on automatic reading,
 * and continue into the same lab staging the automatic index worker runs.
 *
 * Every failure comes back as the outcome the route has always answered with
 * (status, message, `documents.inbound.*` code); the caller renders it as a
 * response or stores it on the run.
 */
import type { OcrSchedule } from "@/lib/documents/ocr-plan";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import type { ProviderChainType } from "@/lib/ai/provider-chain";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import {
  prepareVisionInput,
  refundDocumentAiSlot,
  type LoadedDocument,
} from "@/lib/documents/ai-route-support";
import { maybeAutoStageLabFacts } from "@/lib/documents/auto-stage-labs";
import { upsertContentIndex } from "@/lib/documents/content-index";
import {
  DocumentDescribeError,
  transcribeDocument,
} from "@/lib/documents/describe";
import { recordIndexAttempt } from "@/lib/documents/index-document";
import type { requireDocumentVisionProvider } from "@/lib/documents/provider-order";
import { annotate } from "@/lib/logging/context";

import { settleAiRunBudget } from "./store";
import type {
  AiRunBudget,
  AiRunOutcome,
  DocumentIndexRunResult,
} from "./types";

export type DocumentVisionPick = Awaited<
  ReturnType<typeof requireDocumentVisionProvider>
>;

/**
 * The most sequential model calls one read makes: the transcription, then the
 * lab staging read with its one corrective retry.
 */
export const DOCUMENT_INDEX_MODEL_CALLS = 3;

/** The tokens a vision read reserves before it is dispatched. */
export const DOCUMENT_INDEX_RESERVE_TOKENS =
  AI_BUDGETS.documentTranscribe.maxTokens;

/** Who asked: a request (with its client address) or a background run. */
export interface IndexOrigin {
  ipAddress: string | null;
  worker: boolean;
  /**
   * A background run's deadline, which the lab staging after the index plans
   * its reads against. A request has none: it reads as before.
   */
  schedule?: OcrSchedule;
}

export type DocumentIndexInput =
  | { mode: "text"; text: string }
  | { mode: "vision"; pick: DocumentVisionPick; budget: AiRunBudget };

/** A failure in the shape the route would answer with (`errorCode` literal, so the catalogue guard reads it). */
const failure = (f: {
  status: number;
  message: string;
  errorCode: string;
}): AiRunOutcome<never> => ({ ok: false, ...f });

async function finishIndex(
  userId: string,
  documentId: string,
  source: "vision" | "text-ocr",
  tokenCount: number,
  origin: IndexOrigin,
): Promise<AiRunOutcome<DocumentIndexRunResult>> {
  // Refs #776 — the manual read is the second writer of the attempt record
  // (the auto job + backfill share `indexLoadedDocument`): a success clears
  // any stored failure reason so the detail view stops explaining a problem
  // that no longer exists.
  await recordIndexAttempt(userId, documentId, {
    indexed: true,
    source,
    tokenCount,
  });
  // Read with AI is the person reading the document on purpose, so an
  // import's hold on automatic AI reading (`aiRead=defer`) ends here, before
  // the lab staging below that would otherwise refuse it.
  await prisma.inboundDocument.updateMany({
    where: { id: documentId, userId, aiReadDeferred: true },
    data: { aiReadDeferred: false },
  });
  await auditLog("documents.inbound.index", {
    userId,
    // A background run has no request left to attribute the action from.
    ...(origin.worker ? { actorUserId: userId } : {}),
    ipAddress: origin.ipAddress,
    details: { documentId, source, tokens: tokenCount },
  });
  annotate({
    action: { name: "documents.contentIndex.upsert" },
    meta: { documentId, source, tokens: tokenCount },
  });
  // A manual read continues into the SAME lab staging the automatic index
  // worker performs, so a skipped or failed auto run is recoverable per
  // document without a re-upload. Every guard lives inside the helper (both
  // modules on, still STORED with no facts, provider + consent, looks like a
  // lab report) — a non-lab document is a tagged no-op, and a staging failure
  // never fails the index that just succeeded.
  const staging = await maybeAutoStageLabFacts(userId, documentId, {
    schedule: origin.schedule,
  }).catch(() => null);
  const labFactsStaged = staging?.staged === true ? staging.facts : 0;
  return {
    ok: true,
    data: { documentId, indexed: true, tokenCount, labFactsStaged },
  };
}

/** Index one owned document. The caller has authorised and charged the read. */
export async function executeDocumentIndex(args: {
  userId: string;
  document: LoadedDocument;
  input: DocumentIndexInput;
  origin: IndexOrigin;
}): Promise<AiRunOutcome<DocumentIndexRunResult>> {
  const { userId, document, input, origin } = args;

  if (input.mode === "text") {
    const { tokenCount } = await upsertContentIndex({
      userId,
      documentId: document.id,
      text: input.text,
      source: "text-ocr",
      providerType: null,
    });
    return finishIndex(userId, document.id, "text-ocr", tokenCount, origin);
  }

  const { pick, budget } = input;
  const servedBy = pick.entry.providerType as ProviderChainType;

  const vision = await prepareVisionInput(document, pick.pdfSupported);
  if (!vision.ok) {
    // Preparation failed before any provider dispatch — the reservation and
    // the slot go back. Refs #776 — each failure is also recorded on the row
    // so the detail view can explain the missing index after the toast is
    // gone.
    await settleAiRunBudget(userId, budget, 0, null);
    await refundDocumentAiSlot(userId);
    if (vision.reason === "pdfNeedsAnthropic") {
      await recordIndexAttempt(userId, document.id, {
        indexed: false,
        reason: "pdf-needs-anthropic",
      });
      return failure({
        status: 422,
        message:
          "PDF scanning needs a Claude vision provider; use local OCR instead.",
        errorCode: "documents.inbound.pdfNeedsAnthropic",
      });
    }
    if (vision.reason === "rasterFailed") {
      await recordIndexAttempt(userId, document.id, {
        indexed: false,
        reason: "raster-failed",
      });
      return failure({
        status: 422,
        message: "The PDF pages couldn't be rendered for scanning.",
        errorCode: "documents.inbound.extractFailed",
      });
    }
    if (vision.reason === "fileType") {
      await recordIndexAttempt(userId, document.id, {
        indexed: false,
        reason: "local-unsupported",
      });
      return failure({
        status: 422,
        message: "This document can't be scanned. Use local OCR (text mode).",
        errorCode: "documents.inbound.fileType",
      });
    }
    await recordIndexAttempt(userId, document.id, {
      indexed: false,
      reason: "decrypt-error",
    });
    return failure({
      status: 422,
      message: "Couldn't read the stored document.",
      errorCode: "documents.inbound.extractFailed",
    });
  }

  let text: string;
  try {
    ({ text } = await transcribeDocument({
      provider: pick.entry.instance,
      providerType: pick.providerType,
      images: vision.images,
      documents: vision.documents,
    }));
  } catch (err) {
    await settleAiRunBudget(userId, budget, 0, null);
    await recordIndexAttempt(userId, document.id, {
      indexed: false,
      reason: "provider-error",
    });
    if (err instanceof DocumentDescribeError) {
      return failure({
        status: 422,
        message: "Couldn't read the document. Try a clearer copy.",
        errorCode: "documents.inbound.extractFailed",
      });
    }
    annotate({
      action: { name: "documents.contentIndex.failed" },
      meta: { reason: "provider_error", mode: "vision" },
    });
    return failure({
      status: 502,
      message: "Couldn't read the document. Try a clearer copy.",
      errorCode: "documents.inbound.extractFailed",
    });
  }
  await settleAiRunBudget(userId, budget, budget.reserved, servedBy);

  // Refs #776 — the empty-transcription guard, same contract as the auto
  // path (`tryProviderIndex`): a provider answer with no text must never
  // become a "successful" empty index. The spend stays charged (the
  // provider was called); the honest answer is an error plus the recorded
  // reason.
  if (text.trim().length === 0) {
    await recordIndexAttempt(userId, document.id, {
      indexed: false,
      reason: "empty-transcription",
    });
    return failure({
      status: 422,
      message:
        "The provider returned no text for this document. Try a clearer copy.",
      errorCode: "documents.inbound.extractFailed",
    });
  }
  const { tokenCount } = await upsertContentIndex({
    userId,
    documentId: document.id,
    text,
    source: "vision",
    providerType: pick.providerType,
  });
  return finishIndex(userId, document.id, "vision", tokenCount, origin);
}

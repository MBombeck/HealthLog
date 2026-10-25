/**
 * Pieces the summary, suggest and extract run bodies share: the provider pick
 * types, the failure shape, and the answer for a stored original that could
 * not be turned into a provider input.
 *
 * Every failure here carries the status, message and `documents.inbound.*`
 * code the synchronous route has always answered with, so the background run
 * reports exactly what the request would have.
 */
import type {
  requireDocumentTextProvider,
  requireDocumentVisionProvider,
} from "@/lib/documents/provider-order";
import type { VisionInput } from "@/lib/documents/ai-route-support";

import { AI_RUN_ERROR_CODES, type AiRunOutcome } from "./types";

export type DocumentVisionPick = Awaited<
  ReturnType<typeof requireDocumentVisionProvider>
>;
export type DocumentTextPick = Awaited<
  ReturnType<typeof requireDocumentTextProvider>
>;

/** Who asked: a request (with its client address) or a background run. */
export interface RunOrigin {
  ipAddress: string | null;
  worker: boolean;
}

/** A failure in the shape the route would answer with. */
export const runFailure = (f: {
  status: number;
  message: string;
  errorCode: string;
}): AiRunOutcome<never> => ({ ok: false, ...f });

/** The provider error every document read answers with (422 parse, 502 wire). */
export function unreadableDocument(parseError: boolean): AiRunOutcome<never> {
  return runFailure({
    status: parseError ? 422 : 502,
    message: "Couldn't read the document. Try a clearer copy.",
    errorCode: "documents.inbound.extractFailed",
  });
}

/**
 * The document reader was busy with other work for longer than a person's
 * read waits, or its process ended for no reason it measured. Nothing was
 * read and nothing is charged; asking again in a minute is the answer.
 */
export function readerBusyFailure(): AiRunOutcome<never> {
  return runFailure({
    status: 503,
    message: "The document reader is busy. Try again in a minute.",
    errorCode: AI_RUN_ERROR_CODES.readerBusy,
  });
}

/**
 * A stored original that could not become a provider input, as the summary
 * and suggest routes have always answered it.
 */
export function visionPreparationFailure(
  reason: Extract<VisionInput, { ok: false }>["reason"],
): AiRunOutcome<never> {
  if (reason === "pdfNeedsAnthropic") {
    return runFailure({
      status: 422,
      message:
        "PDF scanning needs a Claude vision provider; use local OCR instead.",
      errorCode: "documents.inbound.pdfNeedsAnthropic",
    });
  }
  if (reason === "readerBusy") return readerBusyFailure();
  if (reason === "fileType") {
    return runFailure({
      status: 422,
      message: "This document can't be scanned. Use local OCR (text mode).",
      errorCode: "documents.inbound.fileType",
    });
  }
  return runFailure({
    status: 422,
    message: "Couldn't read the stored document.",
    errorCode: "documents.inbound.extractFailed",
  });
}

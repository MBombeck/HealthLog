/**
 * A lab report scan, run in the background worker.
 *
 * `POST /api/labs/ocr/extract` checks the capability, the rate bucket and the
 * budget, validates the upload, seals it into a `DocumentAiRun` and answers
 * 202. This is the read itself: the report split into reads (a PDF a page at
 * a time, as many reads as the run's deadline allows; a photo as one; OCR'd
 * text in parts at line boundaries), one extraction per read with its
 * corrective retry, every read after the first reserved against the day's
 * budget on its own, and the whole settled against what the provider
 * reported it spent, a failed scan included.
 *
 * Nothing is written to the person's record here. The proposed rows go back
 * through the run for the mandatory review screen, and the commit route stays
 * the only write path.
 */
import type { Buffer } from "node:buffer";

import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { refusalAsFailure } from "@/lib/documents/ai-runs/http";
import type { ProviderChainType } from "@/lib/ai/provider-chain";
import { meteredReadBudget } from "@/lib/documents/ai-runs/metered-budget";
import {
  AI_RUN_ERROR_CODES,
  type AiRunBudget,
  type AiRunOutcome,
} from "@/lib/documents/ai-runs/types";
import {
  maxReadsFor,
  OCR_EXTRACT_MODEL_CALLS,
  OCR_TEXT_READ_MAX_CHARS,
  planVisionReads,
  splitOcrText,
  type OcrSchedule,
} from "@/lib/documents/ocr-plan";
import { OcrExtractError } from "@/lib/documents/ocr-read";
import type { ProviderChainResolved } from "@/lib/ai/provider-runner";
import type { VisionProviderPick } from "@/lib/labs/ocr-capability";
import {
  runOcrExtraction,
  type RunOcrExtractionArgs,
} from "@/lib/labs/ocr-extract";
import { annotate } from "@/lib/logging/context";
import type { OcrExtractResponseDto } from "@/lib/validations/labs-ocr";

/** The tokens a scan reserves at enqueue, by mode. */
export const OCR_RESERVE_TOKENS = {
  vision: AI_BUDGETS.ocrExtract.maxTokens,
  text: AI_BUDGETS.ocrExtractText.maxTokens,
} as const;

export type OcrVisionPick = NonNullable<VisionProviderPick["pick"]>;
export interface OcrTextPick {
  entry: ProviderChainResolved;
  providerType: string;
}

export type OcrRunInput =
  | { mode: "text"; text: string; pick: OcrTextPick }
  | {
      mode: "vision";
      bytes: Buffer;
      mime: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
      pick: OcrVisionPick;
    };

/**
 * The wide-event facts of a failed provider call: the status and the model,
 * never the upstream body. The base URL can be one a user typed, and what an
 * arbitrary endpoint answers has no business in the event stream (v1.39.3);
 * the stored failure carries neither.
 */
function providerFailureMeta(error: unknown, mode?: "text") {
  const err = error as { httpStatus?: unknown; model?: unknown };
  return {
    reason: "provider_error",
    ...(mode ? { mode } : {}),
    ...(typeof err.httpStatus === "number"
      ? { upstreamStatus: err.httpStatus }
      : {}),
    ...(typeof err.model === "string" ? { model: err.model } : {}),
  };
}

/** A failure in the shape the route would answer with (`errorCode` literal, so the catalogue guard reads it). */
const failure = (f: {
  status: number;
  message: string;
  errorCode: string;
}): AiRunOutcome<never> => ({ ok: false, ...f });

/** The failure a scan that produced nothing usable answers with. */
function unreadable(err: OcrExtractError): AiRunOutcome<never> {
  switch (err.reason) {
    case "output_limit":
      return failure({
        status: 422,
        message:
          "The AI provider stopped at its output limit before it returned a reading.",
        errorCode: "labs.ocr.outputLimit",
      });
    case "budget":
      return failure({
        status: 429,
        message: "Your AI usage budget for today is reached.",
        errorCode: "labs.ocr.budgetExceeded",
      });
    case "unavailable": {
      // The wire's own refusal (the client reads its code: consent, the
      // operator's switch, the module).
      const refused = err.refusal ? refusalAsFailure(err.refusal) : null;
      if (refused) return failure(refused);
      return failure({
        status: 500,
        message: "The background read failed.",
        errorCode: AI_RUN_ERROR_CODES.failed,
      });
    }
    case "error":
      // The check before the first read failed itself.
      return failure({
        status: 500,
        message: "The background read failed.",
        errorCode: AI_RUN_ERROR_CODES.failed,
      });
    default:
      return failure({
        status: 422,
        message: "Couldn't read the report. Try a clearer photo.",
        errorCode: "labs.ocr.extractFailed",
      });
  }
}

/** Read one lab report into proposed rows. The caller authorised the read. */
export async function executeOcrExtraction(args: {
  userId: string;
  input: OcrRunInput;
  budget: AiRunBudget | undefined;
  /**
   * The run's deadline. Required: the scan only runs in the background
   * worker, and a read planned without a bound could make forty model calls.
   */
  schedule: OcrSchedule;
}): Promise<AiRunOutcome<OcrExtractResponseDto>> {
  const { userId, input, budget, schedule } = args;
  const servedBy = input.pick.entry.providerType as ProviderChainType;
  // The route reserved the first read. Every further read is reserved on its
  // own against the day's budget before it is sent, so a long report cannot
  // spend past the budget the route checked once; when the budget runs out
  // the scan stops there and names the pages it did not read. A failed scan
  // is charged for the reads it made.
  const { meter, reserveRead, settle } = meteredReadBudget(
    userId,
    budget,
    servedBy,
  );
  const read = async (
    run: Omit<
      RunOcrExtractionArgs,
      "userId" | "provider" | "providerType" | "meter" | "reserveRead"
    >,
  ): Promise<AiRunOutcome<OcrExtractResponseDto>> => {
    try {
      const result = await runOcrExtraction({
        userId,
        provider: input.pick.entry.instance,
        providerType: input.pick.providerType,
        meter,
        reserveRead,
        ...run,
      });
      await settle(true);
      return { ok: true, data: result.data };
    } catch (err) {
      await settle(false);
      if (err instanceof OcrExtractError) return unreadable(err);
      annotate({
        action: { name: "labs.ocr.extractFailed" },
        meta: providerFailureMeta(
          err,
          run.mode === "text" ? "text" : undefined,
        ),
      });
      return failure({
        status: 502,
        message:
          "The configured AI provider could not process this report. Check the provider configuration and retry.",
        errorCode: "labs.ocr.extractFailed",
      });
    }
  };

  if (input.mode === "text") {
    const parts = splitOcrText(input.text, maxReadsFor(schedule));
    // A part that one read cannot return in full is refused before anything
    // is sent, rather than read into a certain cut: the deadline left too
    // few reads for this much text.
    if (parts.some((part) => part.length > OCR_TEXT_READ_MAX_CHARS)) {
      annotate({
        action: { name: "labs.ocr.fileRejected" },
        meta: { reason: "text_too_large", parts: parts.length },
      });
      await settle(false);
      return failure({
        status: 422,
        message: "This text is too long for one scan.",
        errorCode: "labs.ocr.tooLarge",
      });
    }
    await schedule.arm(parts.length * OCR_EXTRACT_MODEL_CALLS);
    return read({
      mode: "text",
      chunks: parts.map((text) => ({ text, pages: [] })),
    });
  }

  const plan = await planVisionReads(
    input.bytes,
    input.mime,
    input.pick.pdfSupported,
    schedule,
  );
  if (!plan.ok) {
    annotate({
      action: { name: "labs.ocr.fileRejected" },
      meta: { reason: "pdf_rasterize_failed" },
    });
    await settle(false);
    return failure({
      status: 422,
      message: "Couldn't read this PDF; upload a photo instead.",
      errorCode: "labs.ocr.pdfNeedsAnthropic",
    });
  }
  const { chunks, totalPages, pageCoverage } = plan;
  if (pageCoverage) {
    annotate({
      action: { name: "labs.ocr.pagesCapped" },
      meta: { read: pageCoverage.read, total: pageCoverage.total },
    });
  }

  await schedule.arm(chunks.length * OCR_EXTRACT_MODEL_CALLS);
  const outcome = await read({ mode: "vision", chunks, totalPages });
  return outcome.ok && pageCoverage
    ? { ok: true, data: { ...outcome.data, pageCoverage } }
    : outcome;
}

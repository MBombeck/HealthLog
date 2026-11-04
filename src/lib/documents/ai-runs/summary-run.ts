/**
 * A document summary or transcription: the body both the synchronous summary
 * route and the background run execute, so the two paths cannot drift.
 *
 * Vision mode decrypts the stored original and makes one provider call; text
 * mode sends text the browser read on the device. The call runs against a
 * reservation the caller already took, which is settled here. A summary the
 * caller asked to keep is stored on the document (or its refusal recorded as
 * a state); a transcription and an ordinary summary stay transient.
 *
 * Every failure comes back as the outcome the route has always answered with.
 */
import type { ProviderChainType } from "@/lib/ai/provider-chain";
import type { OutboundReason } from "@/lib/ai/safety/outbound-screen";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import {
  prepareVisionInput,
  refundDocumentAiSlot,
  type LoadedDocument,
} from "@/lib/documents/ai-route-support";
import {
  DocumentDescribeError,
  documentSummaryBlockedCopy,
  runDocumentSummary,
  transcribeDocument,
  type DescribeInput,
} from "@/lib/documents/describe";
import { encryptDocumentSummary } from "@/lib/documents/store";
import { providerInputOf } from "@/lib/documents/vision-input";
import type { Locale } from "@/lib/i18n/config";
import { annotate } from "@/lib/logging/context";

import {
  unreadableDocument,
  visionPreparationFailure,
  type DocumentTextPick,
  type DocumentVisionPick,
  type RunOrigin,
} from "./run-support";
import { settleAiRunBudget } from "./store";
import type {
  AiRunBudget,
  AiRunOutcome,
  DocumentSummaryRunResult,
} from "./types";

/** One provider call: the summary, or the transcription. */
export const DOCUMENT_SUMMARY_MODEL_CALLS = 1;

export type DocumentSummaryOutput = "summary" | "text";

export type DocumentSummaryInput =
  | { mode: "text"; text: string; pick: DocumentTextPick; budget: AiRunBudget }
  | { mode: "vision"; pick: DocumentVisionPick; budget: AiRunBudget };

export interface SummaryPersistence {
  /** Replace a stored summary; without it only an empty slot is filled. */
  replaceExisting: boolean;
}

/**
 * Store a screened-clean summary, or record the refusal as a state.
 *
 * A blocked summary NEVER lands as text: the honest statement the caller shows
 * is generated copy for this response, not the model's prose, and persisting it
 * would put a refusal where a summary belongs. Only the WITHHELD state is kept,
 * and it is not terminal: the person can ask again.
 *
 * Storing is best-effort. The summary is already in the answer; a failed write
 * must not turn that into an error.
 */
async function persistSummary(
  userId: string,
  documentId: string,
  persist: SummaryPersistence,
  summary: string,
  blocked: OutboundReason | null,
): Promise<"stored" | "withheld" | "failed"> {
  try {
    if (blocked) {
      await prisma.inboundDocument.updateMany({
        where: {
          id: documentId,
          userId,
          deletedAt: null,
          summaryState: { not: "READY" },
        },
        // An explicit request is the person reading it on purpose, so an
        // import's hold on automatic AI reading ends here.
        data: { summaryState: "WITHHELD", aiReadDeferred: false },
      });
      return "withheld";
    }
    // Preserve a previously stored summary unless the caller explicitly chose
    // the replacement action. Failed or screened attempts never reach this
    // write, so the previous clean summary remains available in those cases.
    const written = await prisma.inboundDocument.updateMany({
      where: {
        id: documentId,
        userId,
        deletedAt: null,
        ...(persist.replaceExisting ? {} : { summaryEncrypted: null }),
      },
      data: {
        summaryEncrypted: encryptDocumentSummary(summary),
        summaryGeneratedAt: new Date(),
        summaryState: "READY",
        aiReadDeferred: false,
      },
    });
    annotate({
      action: { name: "documents.summary.persisted" },
      meta: { documentId, stored: written.count > 0 },
    });
    return written.count > 0 ? "stored" : "failed";
  } catch {
    annotate({
      action: { name: "documents.summary.persistFailed" },
      meta: { documentId },
    });
    return blocked ? "withheld" : "failed";
  }
}

/**
 * Mark a summary the background run was asked to store as not produced. Only
 * the PENDING state the queuing route set is moved, so a summary that landed
 * meanwhile (another tab, the automatic job) is never overwritten.
 */
export async function markQueuedSummaryUnavailable(
  userId: string,
  documentId: string,
): Promise<void> {
  try {
    await prisma.inboundDocument.updateMany({
      where: { id: documentId, userId, summaryState: "PENDING" },
      data: { summaryState: "UNAVAILABLE" },
    });
  } catch {
    // The run's failure is already decided; the hourly summary reaper moves a
    // PENDING state that outlives its job.
  }
}

/**
 * Mark a summary as being generated when a run that will store it is queued,
 * so the detail view says so across reloads. Never over a stored summary: a
 * replacement keeps showing the old one until the new one lands.
 */
export async function markSummaryQueued(
  userId: string,
  documentId: string,
): Promise<void> {
  await prisma.inboundDocument.updateMany({
    where: {
      id: documentId,
      userId,
      deletedAt: null,
      summaryEncrypted: null,
    },
    data: { summaryState: "PENDING" },
  });
}

/** Summarise or transcribe one owned document. The caller authorised and charged it. */
export async function executeDocumentSummary(args: {
  userId: string;
  document: LoadedDocument;
  input: DocumentSummaryInput;
  output: DocumentSummaryOutput;
  locale: Locale;
  persist: SummaryPersistence | null;
  origin: RunOrigin;
}): Promise<AiRunOutcome<DocumentSummaryRunResult>> {
  const { userId, document, input, output, locale, origin } = args;
  const { pick, budget } = input;
  const servedBy = pick.entry.providerType as ProviderChainType;

  let describeInput: DescribeInput;
  if (input.mode === "text") {
    describeInput = {
      provider: pick.entry.instance,
      providerType: pick.providerType,
      ocrText: input.text,
    };
  } else {
    const vision = await prepareVisionInput(document, input.pick.pdfSupported);
    if (!vision.ok) {
      // Preparation failed before any provider dispatch: the reservation and
      // the slot go back.
      await settleAiRunBudget(userId, budget, 0, null);
      await refundDocumentAiSlot(userId);
      return visionPreparationFailure(vision.reason);
    }
    describeInput = {
      provider: pick.entry.instance,
      providerType: pick.providerType,
      ...providerInputOf(vision),
    };
  }

  let result: DocumentSummaryRunResult;
  try {
    if (output === "text") {
      result = await transcribeDocument(describeInput);
    } else {
      const { summary, blocked } = await runDocumentSummary({
        ...describeInput,
        locale,
      });
      const persistence = args.persist
        ? await persistSummary(
            userId,
            document.id,
            args.persist,
            summary,
            blocked,
          )
        : undefined;
      result = {
        summary: blocked ? documentSummaryBlockedCopy(locale) : summary,
        ...(persistence ? { persistence } : {}),
      };
    }
  } catch (err) {
    await settleAiRunBudget(userId, budget, 0, null);
    if (!(err instanceof DocumentDescribeError)) {
      annotate({
        action: { name: "documents.summary.failed" },
        meta: { reason: "provider_error", mode: input.mode },
      });
    }
    return unreadableDocument(err instanceof DocumentDescribeError);
  }
  await settleAiRunBudget(userId, budget, budget.reserved, servedBy);

  await auditLog("documents.inbound.summary", {
    userId,
    // A background run has no request left to attribute the action from.
    ...(origin.worker ? { actorUserId: userId } : {}),
    ipAddress: origin.ipAddress,
    details: { documentId: document.id, mode: output, inputMode: input.mode },
  });
  annotate({
    action: { name: "documents.summary.serve" },
    meta: { documentId: document.id, mode: output, inputMode: input.mode },
  });
  return { ok: true, data: result };
}

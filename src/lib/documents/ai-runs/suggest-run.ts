/**
 * Filing suggestions for a stored document: the body both the synchronous
 * suggest route and the background run execute.
 *
 * One provider call over the stored original (vision) or text the browser read
 * (text) returns a `{ title, kind, documentDate }` draft. Nothing is written to
 * the document: the person reviews the draft and saves it on the edit form.
 * The reservation the caller took is settled here.
 */
import type { ProviderChainType } from "@/lib/ai/provider-chain";
import { auditLog } from "@/lib/auth/audit";
import {
  prepareVisionInput,
  refundDocumentAiSlot,
  type LoadedDocument,
} from "@/lib/documents/ai-route-support";
import {
  DocumentAssistError,
  runDocumentAssist,
  type DocumentSuggestion,
} from "@/lib/documents/assist";
import { providerInputOf } from "@/lib/documents/vision-input";
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
  DocumentSuggestRunResult,
} from "./types";

/** One provider call. */
export const DOCUMENT_SUGGEST_MODEL_CALLS = 1;

export type DocumentSuggestInput =
  | { mode: "text"; text: string; pick: DocumentTextPick; budget: AiRunBudget }
  | { mode: "vision"; pick: DocumentVisionPick; budget: AiRunBudget };

/** Suggest filing details for one owned document. The caller authorised and charged it. */
export async function executeDocumentSuggest(args: {
  userId: string;
  document: LoadedDocument;
  input: DocumentSuggestInput;
  origin: RunOrigin;
}): Promise<AiRunOutcome<DocumentSuggestRunResult>> {
  const { userId, document, input, origin } = args;
  const { pick, budget } = input;
  const servedBy = pick.entry.providerType as ProviderChainType;

  let suggestion: DocumentSuggestion;
  try {
    if (input.mode === "text") {
      suggestion = await runDocumentAssist({
        provider: pick.entry.instance,
        providerType: pick.providerType,
        ocrText: input.text,
      });
    } else {
      const vision = await prepareVisionInput(
        document,
        input.pick.pdfSupported,
      );
      if (!vision.ok) {
        // Preparation failed before any provider dispatch: the reservation
        // and the slot go back.
        await settleAiRunBudget(userId, budget, 0, null);
        await refundDocumentAiSlot(userId);
        return visionPreparationFailure(vision.reason);
      }
      suggestion = await runDocumentAssist({
        provider: pick.entry.instance,
        providerType: pick.providerType,
        ...providerInputOf(vision),
      });
    }
  } catch (err) {
    await settleAiRunBudget(userId, budget, 0, null);
    if (!(err instanceof DocumentAssistError)) {
      annotate({
        action: { name: "documents.assist.failed" },
        meta: { reason: "provider_error", mode: input.mode },
      });
    }
    return unreadableDocument(err instanceof DocumentAssistError);
  }
  await settleAiRunBudget(userId, budget, budget.reserved, servedBy);

  await auditLog("documents.inbound.suggest", {
    userId,
    ...(origin.worker ? { actorUserId: userId } : {}),
    ipAddress: origin.ipAddress,
    details: { documentId: document.id, mode: input.mode },
  });
  annotate({
    action: { name: "documents.assist.suggest" },
    meta: {
      documentId: document.id,
      mode: input.mode,
      hasTitle: suggestion.title !== null,
      hasKind: suggestion.kind !== null,
      hasDate: suggestion.documentDate !== null,
    },
  });
  return { ok: true, data: { suggestions: suggestion } };
}

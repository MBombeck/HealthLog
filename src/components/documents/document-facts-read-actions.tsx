"use client";

/**
 * The two ways a stored lab result with nothing staged is read into the
 * review, both over the document's stored text and never a re-upload:
 *
 *   - "Extract lab values" structures the text with the AI provider
 *     (`POST …/extract`, `{ mode: "stored" }`), run in the background; only
 *     when AI is available for this record.
 *   - "Read values without AI" reads the table rows by rule on the server
 *     (`POST …/lab-values`). Offered whatever the AI settings say: reading
 *     data needs no model.
 *
 * Either one stages PENDING facts for the same review; nothing is saved
 * here. Over values read by rule and not yet confirmed, the AI read is
 * offered on its own (`withoutAi={false}`): it replaces them.
 */
import { ListChecks, ScanSearch } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { DocumentExtractRunResult } from "@/lib/documents/ai-runs/types";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { InboundDocumentDetailDto } from "@/lib/validations/inbound-documents";

import { AiRunPhaseNote } from "./document-ai-panels";
import { useDocumentAiErrorText } from "./use-document-assist";
import { useLocalLabValues, useStoredExtract } from "./use-document-facts";

/**
 * What the person is told when a read finishes. The staged facts arrive
 * with the document refetch the hook starts; the review opens onto them. A
 * long document read in parts may have had a part cut at the provider's
 * output limit or not reached, and then the review is not the whole
 * document.
 */
function announceExtract(
  result: Pick<DocumentExtractRunResult, "factsStaged" | "incomplete">,
  t: (key: string) => string,
  openReview: () => void,
): void {
  if (result.factsStaged > 0) openReview();
  else toast.info(t("documents.review.extractEmpty"));
  if (result.incomplete) {
    toast.warning(t("documents.review.extractIncomplete"));
  }
}

/** What the model-free read staged, in the shape the announcement reads. */
function stagedSummary(
  staged: InboundDocumentDetailDto,
): Pick<DocumentExtractRunResult, "factsStaged" | "incomplete"> {
  return {
    factsStaged: staged.facts.filter((fact) => fact.status === "PENDING")
      .length,
    ...(staged.extractionIncomplete ? { incomplete: true as const } : {}),
  };
}

export function DocumentFactsReadActions({
  documentId,
  canExtract,
  withoutAi = true,
  onStaged,
  openReview,
}: {
  documentId: string;
  /** AI is available for this record: the provider read is offered too. */
  canExtract: boolean;
  /** Offer the read by rule. Off where its values are already staged. */
  withoutAi?: boolean;
  /** A read staged new facts: the review's local choices start over. */
  onStaged: () => void;
  openReview: () => void;
}) {
  const { t } = useTranslations();
  const storedExtract = useStoredExtract();
  const localValues = useLocalLabValues();
  const aiErrorText = useDocumentAiErrorText();
  const onError = (error: Error) =>
    showErrorToast(aiErrorText(error), { cause: error });

  return (
    <div className="space-y-3">
      {canExtract ? (
        <div className="space-y-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-slot="document-facts-extract"
            className="min-h-11 sm:min-h-9"
            onClick={() =>
              storedExtract.mutate(
                { documentId },
                {
                  onSuccess: (result) => {
                    onStaged();
                    announceExtract(result, t, openReview);
                  },
                  onError,
                },
              )
            }
            disabled={storedExtract.isPending}
          >
            <ScanSearch
              className={cn(
                "size-4",
                storedExtract.isPending &&
                  "animate-pulse motion-reduce:animate-none",
              )}
              aria-hidden
            />
            {storedExtract.isPending
              ? t("documents.review.extracting")
              : t("documents.review.extract")}
          </Button>
          {storedExtract.runPhase === "idle" ? (
            <p className="text-muted-foreground text-xs">
              {t("documents.review.extractHint")}
            </p>
          ) : (
            // While the read runs, the hint gives way to where it stands:
            // one muted line, the same one every document read shows.
            <AiRunPhaseNote
              phase={storedExtract.runPhase}
              outcome="savedWithDocument"
              slot="document-facts-extract-run-phase"
            />
          )}
        </div>
      ) : null}
      {withoutAi ? (
        <div className="space-y-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-slot="document-facts-read-locally"
            className="min-h-11 sm:min-h-9"
            onClick={() =>
              localValues.mutate(
                { documentId },
                {
                  onSuccess: (staged) => {
                    onStaged();
                    announceExtract(stagedSummary(staged), t, openReview);
                  },
                  onError,
                },
              )
            }
            disabled={localValues.isPending}
          >
            <ListChecks
              className={cn(
                "size-4",
                localValues.isPending &&
                  "animate-pulse motion-reduce:animate-none",
              )}
              aria-hidden
            />
            {localValues.isPending
              ? t("documents.review.readLocallyPending")
              : t("documents.review.readLocally")}
          </Button>
          <p className="text-muted-foreground text-xs">
            {t("documents.review.readLocallyHint")}
          </p>
        </div>
      ) : null}
    </div>
  );
}

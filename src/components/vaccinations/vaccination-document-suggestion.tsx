"use client";

/**
 * The from-upload half of the document link: a scan classified `VACCINATION`
 * offers to file itself against a dose recorded around the same date.
 *
 * The RULE is not here — it lives in `src/lib/vaccinations/document-suggestion.ts`
 * and is resolved server-side, the same ±7-day window the visit moment uses, so
 * the two cannot drift. What this owns is only how the three verdicts look:
 *
 *   one candidate  → pre-selected, visibly;
 *   two or more    → a picker with NOTHING pre-selected;
 *   none           → nothing at all.
 *
 * The middle branch is the point, and this file never picks one of a "many":
 * that verdict carries no pre-selection. It never blocks the upload — linking is
 * an offer, and the facade's link is idempotent, so a second tap is a no-op.
 */
import { useState } from "react";
import { Check, Syringe } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { useDateFormatPreference, useTranslations } from "@/lib/i18n/context";
import {
  useLinkDocumentToVaccination,
  useVaccinationSuggestion,
} from "./use-vaccinations";
import type { VaccinationSuggestion } from "@/lib/vaccinations/document-suggestion";
import { formatDate as formatCalendarDate } from "@/lib/date-format";

export function VaccinationDocumentSuggestion({
  anchor,
  documentId,
  disabled,
}: {
  /** `reportDate ?? documentDate`, date-only; null means nothing to ask. */
  anchor: string | null;
  documentId: string;
  disabled?: boolean;
}) {
  const { t, locale } = useTranslations();
  const dateFormat = useDateFormatPreference();
  // Lift the date-only anchor to noon UTC — the rule is a ±7-day window, so the
  // time never changes the verdict, and noon keeps a viewer's local midnight
  // from rounding the day either way. The bare date would 422 the endpoint.
  const instant = anchor ? `${anchor}T12:00:00.000Z` : null;
  const suggestion = useVaccinationSuggestion(instant, !disabled);
  const link = useLinkDocumentToVaccination();
  const [linkedId, setLinkedId] = useState<string | null>(null);

  if (disabled) return null;
  const result = suggestion.data;
  if (!result || result.kind === "none") return null;

  const candidates =
    result.kind === "one" ? [result.vaccination] : result.vaccinations;

  const label = (candidate: VaccinationSuggestion) => {
    const name = candidate.antigenSlug
      ? t(`vaccinations.catalog.${candidate.antigenSlug}`)
      : (candidate.vaccineName ?? t("vaccinations.suggestion.unnamed"));
    // A date stored at UTC midnight: render the calendar date, not the
    // instant (the previous evening west of UTC).
    return `${name}, ${formatCalendarDate(candidate.occurredAt.slice(0, 10), dateFormat, locale)}`;
  };

  const onPick = (candidate: VaccinationSuggestion) => {
    link.mutate(
      { vaccinationId: candidate.id, documentId },
      {
        onSuccess: () => {
          setLinkedId(candidate.id);
          toastWrittenOutcome("success", t("vaccinations.suggestion.linked"));
        },
        onError: () => toast.error(t("vaccinations.suggestion.failed")),
      },
    );
  };

  return (
    <div
      className="space-y-1.5"
      data-slot="vaccination-document-suggestion"
      data-verdict={result.kind}
      data-candidates={candidates.length}
    >
      <p className="text-foreground flex items-center gap-2 text-sm">
        <Syringe className="size-4 shrink-0" aria-hidden />
        {t(
          result.kind === "one"
            ? "vaccinations.suggestion.single"
            : "vaccinations.suggestion.choose",
        )}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {candidates.map((candidate) => {
          const chosen = linkedId === candidate.id;
          return (
            <Button
              key={candidate.id}
              type="button"
              variant={chosen ? "default" : "outline"}
              size="sm"
              className="min-h-11"
              aria-pressed={chosen}
              disabled={link.isPending || linkedId !== null}
              data-slot="vaccination-document-suggestion-option"
              onClick={() => onPick(candidate)}
            >
              {result.kind === "one" || chosen ? (
                <Check
                  className="size-4"
                  aria-hidden
                  style={{ opacity: chosen ? 1 : 0.5 }}
                />
              ) : null}
              {label(candidate)}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

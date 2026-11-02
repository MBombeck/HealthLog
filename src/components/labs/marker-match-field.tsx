"use client";

/**
 * v1.43 — which marker a reviewed lab value goes to.
 *
 * Shared by the scan review and the document review. The server resolves a
 * printed name to one of the account's markers (its name, an alias, or a
 * catalog abbreviation such as "T.Bili") and, when nothing resolves, offers up
 * to three markers to choose from. This renders that resolution: the marker a
 * value was matched to, or a choice between the suggestions and a new marker.
 * A choice is remembered by the server as another spelling of the marker, so
 * the next report from the same lab matches on its own.
 *
 * Nothing is computed here: the match, its kind and the suggestions all come
 * from the review DTO.
 */
import { useId } from "react";
import { FilePlus2, Link2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { useTranslations } from "@/lib/i18n/context";
import { labUnitLabel } from "@/lib/labs/dimensionless";

export interface MarkerSuggestionDto {
  biomarkerId: string;
  name: string;
  unit: string;
  matchKind: "catalog" | "similar";
}

/** The value for "a new marker" in the choice. */
const NEW_MARKER = "";

export function MarkerMatchField({
  matchedName,
  matchKind,
  suggestions,
  chosenId,
  onChoose,
  slot,
}: {
  /** The marker the server matched, by name; null when nothing matched. */
  matchedName: string | null;
  matchKind: "name" | "alias" | "catalog" | null;
  suggestions: readonly MarkerSuggestionDto[];
  /** The suggestion the person picked, or null for a new marker. */
  chosenId: string | null;
  onChoose: (suggestion: MarkerSuggestionDto | null) => void;
  /** `data-slot` prefix for tests. */
  slot: string;
}) {
  const { t } = useTranslations();
  const selectId = useId();

  if (matchedName !== null) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge
          variant="outline"
          className="text-muted-foreground max-w-full"
          title={t("labs.ocr.linksExisting", { name: matchedName })}
          data-slot={`${slot}-matched`}
        >
          <Link2 aria-hidden />
          <span className="truncate">
            {t("labs.ocr.linksExisting", { name: matchedName })}
          </span>
        </Badge>
        {matchKind === "alias" || matchKind === "catalog" ? (
          <span className="text-muted-foreground text-xs">
            {matchKind === "alias"
              ? t("labs.match.viaAlias")
              : t("labs.match.viaCatalog")}
          </span>
        ) : null}
      </div>
    );
  }

  if (suggestions.length === 0) {
    return (
      <Badge
        variant="outline"
        className="text-muted-foreground"
        data-slot={`${slot}-new`}
      >
        <FilePlus2 aria-hidden />
        {t("labs.ocr.newBiomarker")}
      </Badge>
    );
  }

  return (
    <div className="space-y-1.5" data-slot={`${slot}-choice`}>
      <Label htmlFor={selectId} className="text-xs">
        {t("labs.match.chooseLabel")}
      </Label>
      <NativeSelect
        id={selectId}
        value={chosenId ?? NEW_MARKER}
        onChange={(event) =>
          onChoose(
            suggestions.find((s) => s.biomarkerId === event.target.value) ??
              null,
          )
        }
      >
        {suggestions.map((suggestion) => (
          <option key={suggestion.biomarkerId} value={suggestion.biomarkerId}>
            {t("labs.match.suggestionOption", {
              name: suggestion.name,
              unit: labUnitLabel(suggestion.unit, t),
            })}
          </option>
        ))}
        <option value={NEW_MARKER}>{t("labs.match.newMarkerOption")}</option>
      </NativeSelect>
      <p className="text-muted-foreground text-xs">
        {chosenId ? t("labs.match.rememberHint") : t("labs.match.chooseHint")}
      </p>
    </div>
  );
}

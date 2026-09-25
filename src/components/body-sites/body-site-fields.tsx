"use client";

/**
 * The "Body site / Side" field pair, shared by the visit form and the
 * condition form (v1.39.2).
 *
 * One component rather than two copies, because the point of the pair is that
 * a knee is written the same way on a procedure and on a condition: the field
 * offers the sites the record already holds, across both kinds, as the person
 * types. The list comes from the server (`useBodySiteSuggestions`), which
 * decrypts and folds the sites; the browser's own `datalist` does the
 * narrowing, so a suggestion is a nudge and never a restriction. A caller whose
 * grant cannot read the list gets a plain text field.
 */
import { useId } from "react";

import { FieldGroup } from "@/components/ui/field-group";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { useBodySiteSuggestions } from "@/hooks/use-body-sites";
import { useTranslations } from "@/lib/i18n/context";
import {
  LATERALITIES,
  lateralityText,
} from "@/components/encounters/encounter-labels";

export type BodySiteSideValue = "LEFT" | "RIGHT" | "BOTH" | null;

export function BodySiteFields({
  idPrefix,
  bodySite,
  laterality,
  onBodySiteChange,
  onLateralityChange,
  hint,
}: {
  /** Prefix for the two input ids, so a label and a test can address them. */
  idPrefix: string;
  bodySite: string;
  laterality: BodySiteSideValue;
  onBodySiteChange: (value: string) => void;
  onLateralityChange: (value: BodySiteSideValue) => void;
  hint?: string;
}) {
  const { t } = useTranslations();
  const listId = `${useId()}-body-sites`;
  const typed = bodySite.trim().toLowerCase();
  // The exact site already typed is not suggested back to itself.
  const suggestions = useBodySiteSuggestions().filter(
    (site) => site.toLowerCase() !== typed,
  );

  return (
    <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
      <FieldGroup
        htmlFor={`${idPrefix}-body-site`}
        label={t("encounters.form.bodySite")}
        hint={hint ?? t("encounters.form.bodySiteHint")}
      >
        <Input
          id={`${idPrefix}-body-site`}
          value={bodySite}
          maxLength={200}
          autoComplete="off"
          list={suggestions.length > 0 ? listId : undefined}
          onChange={(event) => onBodySiteChange(event.target.value)}
        />
        {suggestions.length > 0 ? (
          <datalist id={listId} data-slot="body-site-suggestions">
            {suggestions.map((site) => (
              <option key={site} value={site} />
            ))}
          </datalist>
        ) : null}
      </FieldGroup>
      <FieldGroup
        htmlFor={`${idPrefix}-laterality`}
        label={t("encounters.form.laterality")}
      >
        <NativeSelect
          id={`${idPrefix}-laterality`}
          value={laterality ?? ""}
          onChange={(event) =>
            onLateralityChange(
              (event.target.value as BodySiteSideValue) || null,
            )
          }
        >
          <option value="">{t("encounters.laterality.none")}</option>
          {LATERALITIES.map((side) => (
            <option key={side} value={side}>
              {lateralityText(t, side)}
            </option>
          ))}
        </NativeSelect>
      </FieldGroup>
    </div>
  );
}

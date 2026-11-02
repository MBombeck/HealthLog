"use client";

import { formatReferenceRange } from "@/lib/labs/reference-range";
import { useTranslations } from "@/lib/i18n/context";

import type { LabResultDto } from "./types";
import { useLabNumber } from "./use-lab-format";
import { withLabUnit } from "@/lib/labs/dimensionless";

/**
 * The reference window a reading's own report printed, shown wherever that
 * reading is shown.
 *
 * Renders nothing for a reading with no printed window — most of them — so it
 * costs no space on the common row. When the report DID state a window it
 * names it, verbatim where the report gave words; and when that window and the
 * catalog band disagree it names the catalog band too. A reader told only
 * "3,9–5,4" and a reader told only "3,5–5,0" draw different conclusions from
 * the same number, so a surface that shows one silently is showing a partial
 * answer.
 *
 * A reading converted into its marker's unit carries bounds that were converted
 * with it, but the report's own text is still in the unit it printed. The note
 * then states the window in the marker's unit and adds the printed text as
 * evidence, labelled with its unit, so no single statement mixes two units.
 *
 * Neutral by construction: no tint, no icon, muted text. The in/out verdict is
 * the badge's job — this element states where the window came from, nothing
 * about whether the value is good news.
 */
export function SourceRangeNote({
  reading,
  className,
}: {
  reading: Pick<
    LabResultDto,
    | "unit"
    | "referenceLow"
    | "referenceHigh"
    | "catalogReferenceLow"
    | "catalogReferenceHigh"
    | "sourceReferenceText"
    | "printedReferenceText"
    | "sourceUnit"
    | "referenceOrigin"
    | "referenceDivergesFromCatalog"
  >;
  className?: string;
}) {
  const { t } = useTranslations();
  const labNumber = useLabNumber();
  if (reading.referenceOrigin !== "source") return null;

  // `sourceReferenceText` is null for a converted reading, so the window is
  // then stated from the converted bounds, in the marker's unit.
  const inForce =
    reading.sourceReferenceText ??
    withLabUnit(
      formatReferenceRange(
        reading.referenceLow,
        reading.referenceHigh,
        labNumber,
      ),
      reading.unit,
    );

  const catalog = formatReferenceRange(
    reading.catalogReferenceLow,
    reading.catalogReferenceHigh,
    labNumber,
  );

  return (
    <span className={className}>
      {t("labs.sourceRange.fromReport", { range: inForce })}
      {reading.printedReferenceText && reading.sourceUnit
        ? ` · ${t("labs.sourceRange.printed", {
            range: reading.printedReferenceText,
            unit: reading.sourceUnit,
          })}`
        : null}
      {reading.referenceDivergesFromCatalog && catalog
        ? ` · ${t("labs.sourceRange.catalogDiffers", {
            range: withLabUnit(catalog, reading.unit),
          })}`
        : null}
    </span>
  );
}

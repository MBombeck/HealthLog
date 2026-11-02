"use client";

/**
 * v1.18.9 — a single proposed Lab-OCR row on the review screen.
 *
 * Mandatory human review: each row is shown for per-row confirm/edit/discard.
 * The checkbox confirms; the inline fields edit analyte / value-or-valueText /
 * unit / reference range / date. Server-computed hints surface as calm badges:
 * a new-vs-existing-biomarker hint, a duplicate warning (the row defaults to
 * unchecked when flagged), and a low-confidence flag per the model's self-score.
 *
 * The no-alarming-colour ethos holds: an out-of-range or duplicate row is not
 * painted red — these are informative `secondary`/`outline` badges, same weight
 * as the in-range state.
 */
import { useId } from "react";

import { AlertCircle, Ruler, TriangleAlert } from "lucide-react";

import { FieldError } from "@/components/forms/field-error";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/lib/i18n/context";
import { isDimensionlessUnit, labUnitLabel } from "@/lib/labs/dimensionless";
import {
  OCR_ANALYTE_MAX,
  OCR_UNIT_MAX,
  OCR_VALUE_TEXT_MAX,
} from "@/lib/validations/labs-ocr";

import { LabUnitInput } from "./lab-unit-input";
import { MarkerMatchField } from "./marker-match-field";
import { chooseMarker, type OcrReviewRow } from "./ocr-review-types";
import {
  readingConversion,
  readingUnitBlocked,
  type OcrRowErrors,
} from "./ocr-review-validation";
import { useLabNumber } from "./use-lab-format";

/** Below this per-field confidence the field is flagged for a second look. */
const CONFIDENCE_THRESHOLD = 0.6;

/** The visible marker that a field must be filled before the row can save. */
function RequiredMark() {
  return (
    <span aria-hidden className="text-destructive">
      {" *"}
    </span>
  );
}

type Translate = (key: string, params?: Record<string, string>) => string;

/** The badge naming a row whose unit differs from its marker's. */
function unitDiffersText(row: OcrReviewRow, t: Translate): string {
  const unit = labUnitLabel(row.unit, t);
  return isDimensionlessUnit(row.markerUnit)
    ? t("labs.ocr.unitDiffersBadgeNoUnit", { unit })
    : t("labs.ocr.unitDiffersBadge", {
        markerUnit: row.markerUnit ?? "",
        unit,
      });
}

/** The message key and params of a unit the marker cannot take. */
function unitMismatchMessage(
  row: OcrReviewRow,
): [string, Record<string, string>?] {
  return isDimensionlessUnit(row.markerUnit)
    ? ["labs.ocr.errorUnitMismatchNoUnit"]
    : ["labs.ocr.errorUnitMismatch", { markerUnit: row.markerUnit ?? "" }];
}

export function OcrRowEditor({
  row,
  onChange,
  errors,
  markerLookup = () => null,
}: {
  row: OcrReviewRow;
  onChange: (next: OcrReviewRow) => void;
  /**
   * The account's marker by id, for the matched marker's name and the
   * analyte a chosen suggestion converts with. Absent: names fall back to the
   * printed analyte.
   */
  markerLookup?: (
    biomarkerId: string,
  ) => { name: string; analyteKey: string | null } | null;
  /** The blocking fields of this row, once a save has been attempted. */
  errors?: OcrRowErrors;
}) {
  const { t } = useTranslations();
  const fieldId = useId();
  const invalidProps = (field: keyof OcrRowErrors) =>
    errors?.[field]
      ? {
          "aria-invalid": true as const,
          "aria-describedby": `${fieldId}-${field}-error`,
        }
      : {};
  const fieldError = (
    field: keyof OcrRowErrors,
    messageKey: string,
    params?: Record<string, string>,
  ) =>
    errors?.[field] ? (
      <FieldError
        id={`${fieldId}-${field}-error`}
        message={t(messageKey, params)}
      />
    ) : null;
  // Stated before Save, not only after a failed attempt. A reading in another
  // unit than its marker's is either converted (the badge says what Save will
  // store) or cannot be written (the person should see why the row is unticked,
  // or will not save, while they are still reading it).
  const unitBlocked = readingUnitBlocked(row);
  const conversion = readingConversion(row);
  const labNumber = useLabNumber();

  const isQualitative = row.valueText !== null && row.valueText !== undefined;
  const lowValueConfidence =
    !isQualitative && row.confidence.value < CONFIDENCE_THRESHOLD;
  const valueUnreadable = !isQualitative && row.value === null;

  // The model self-scores each field it transcribed. Surface a single calm
  // per-row flag when ANY tracked field came back below the threshold so a
  // shaky read is visible at a glance — including on qualitative rows, which
  // have no value-confidence footnote of their own. Informative, not alarming.
  const lowRowConfidence =
    row.confidence.analyte < CONFIDENCE_THRESHOLD ||
    row.confidence.unit < CONFIDENCE_THRESHOLD ||
    (isQualitative
      ? row.confidence.value < CONFIDENCE_THRESHOLD
      : lowValueConfidence);

  // v1.18.10 (#5) — a NEW numeric biomarker mints its catalog reference range
  // from THIS extracted row. The range is therefore load-bearing and worth a
  // second look. Surface the range confidence prominently for new numeric
  // markers, and call it out explicitly when the model was unsure (or set no
  // bounds at all) so the user verifies the range it will be judged against.
  const isNewNumericMarker = !isQualitative && row.biomarkerMatch === "new";
  const lowRangeConfidence = row.confidence.range < CONFIDENCE_THRESHOLD;
  const hasBounds = row.referenceLow !== null || row.referenceHigh !== null;
  const flagRange = isNewNumericMarker && (lowRangeConfidence || !hasBounds);

  return (
    // `@container` makes the row follow the width of the dialog, not the
    // window: in a narrow dialog (or on a phone) it stacks as before; once the
    // dialog is wide enough it splits into the reading on the left and its
    // fields on the right, so a long report reads as a table, not a column.
    <div className="@container">
      <div className="space-y-3 rounded-lg border p-3 @3xl:grid @3xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] @3xl:items-start @3xl:space-y-0 @3xl:gap-x-6">
        <div className="flex items-start gap-3">
          {/* The checkbox is the PRIMARY per-row confirm on a touch-first OCR
            review screen, so it needs a ≥44px hit area on coarse pointers. The
            wrapping label supplies the touch target (and forwards the click to
            the control) without enlarging the 20px glyph or bloating the row on
            desktop, where the negative margins collapse the padding back. */}
          <label
            htmlFor={`${fieldId}-confirm`}
            className="-m-3 flex min-h-11 min-w-11 cursor-pointer items-start justify-center p-3 sm:m-0 sm:min-h-0 sm:min-w-0 sm:p-0"
          >
            <Checkbox
              id={`${fieldId}-confirm`}
              checked={row.confirmed}
              onCheckedChange={(checked) =>
                onChange({ ...row, confirmed: checked === true })
              }
              className="mt-0.5 min-h-5 min-w-5 sm:mt-1"
              aria-label={t("labs.ocr.confirmRow")}
            />
          </label>
          <div className="min-w-0 flex-1 space-y-1">
            <Input
              value={row.analyte}
              onChange={(e) => onChange({ ...row, analyte: e.target.value })}
              aria-label={t("labs.ocr.analyteLabel")}
              {...invalidProps(
                errors?.analyteTooLong ? "analyteTooLong" : "analyte",
              )}
              className="font-medium"
            />
            {fieldError("analyte", "labs.ocr.errorAnalyte")}
            {fieldError("analyteTooLong", "labs.ocr.errorTooLong", {
              max: String(OCR_ANALYTE_MAX),
            })}
            {/* v1.43 — the marker this value goes to: the server's
                match, or a choice between its suggestions and a new one. */}
            <MarkerMatchField
              matchedName={
                row.biomarkerId !== null
                  ? (markerLookup(row.biomarkerId)?.name ?? row.analyte)
                  : null
              }
              matchKind={row.matchKind}
              suggestions={row.suggestions}
              chosenId={row.chosenBiomarkerId}
              onChoose={(suggestion) =>
                onChange(
                  chooseMarker(
                    row,
                    suggestion,
                    (id) => markerLookup(id)?.analyteKey ?? null,
                  ),
                )
              }
              slot="ocr-row-marker"
            />
            <div className="flex flex-wrap items-center gap-1.5">
              {row.duplicateOf ? (
                <Badge variant="secondary">
                  <TriangleAlert aria-hidden />
                  {t("labs.ocr.duplicateWarning")}
                </Badge>
              ) : null}
              {unitBlocked ? (
                <Badge variant="secondary" className="max-w-full">
                  <Ruler aria-hidden />
                  <span className="truncate">{unitDiffersText(row, t)}</span>
                </Badge>
              ) : null}
              {conversion ? (
                <Badge
                  variant="outline"
                  // Wraps rather than truncates: the printed value is the end
                  // of the sentence, exactly what a cut at 390 px would hide.
                  className="h-auto max-w-full justify-start rounded-md text-left whitespace-normal"
                  data-slot="ocr-row-converted-badge"
                >
                  <Ruler aria-hidden />
                  <span className="min-w-0 break-words">
                    {t("labs.ocr.unitConvertedBadge", {
                      value: labNumber(
                        conversion.value,
                        conversion.statedValue,
                      ),
                      markerUnit: conversion.unit,
                      statedValue: labNumber(conversion.statedValue),
                      unit: conversion.statedUnit,
                    })}
                  </span>
                </Badge>
              ) : null}
              {lowRowConfidence ? (
                <Badge variant="secondary" className="text-muted-foreground">
                  <AlertCircle aria-hidden />
                  {t("labs.ocr.lowConfidenceBadge")}
                </Badge>
              ) : null}
            </div>
          </div>
        </div>

        {/* The fields are a container of their own, so how many columns they
          get follows the width they actually have: the whole row when
          stacked, the right-hand column once the row splits. */}
        <div className="@container min-w-0 space-y-3">
          <div className="grid grid-cols-2 gap-2 @md:grid-cols-3">
            {isQualitative ? (
              <div className="col-span-2 space-y-1 @md:col-span-3">
                <Label htmlFor={`${fieldId}-vt`} className="text-xs">
                  {t("labs.ocr.resultLabel")}
                  <RequiredMark />
                </Label>
                <Input
                  id={`${fieldId}-vt`}
                  value={row.valueText ?? ""}
                  onChange={(e) =>
                    onChange({ ...row, valueText: e.target.value })
                  }
                  {...invalidProps(
                    errors?.valueTextTooLong ? "valueTextTooLong" : "valueText",
                  )}
                />
                {fieldError("valueText", "labs.ocr.errorResult")}
                {fieldError("valueTextTooLong", "labs.ocr.errorTooLong", {
                  max: String(OCR_VALUE_TEXT_MAX),
                })}
              </div>
            ) : (
              <>
                <div className="space-y-1">
                  <Label htmlFor={`${fieldId}-val`} className="text-xs">
                    {t("labs.ocr.valueLabel")}
                    <RequiredMark />
                  </Label>
                  <Input
                    id={`${fieldId}-val`}
                    inputMode="decimal"
                    value={row.value === null ? "" : String(row.value)}
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      const parsed = raw === "" ? null : Number(raw);
                      onChange({
                        ...row,
                        value:
                          parsed !== null && Number.isFinite(parsed)
                            ? parsed
                            : null,
                      });
                    }}
                    {...invalidProps("value")}
                  />
                  {fieldError("value", "labs.ocr.errorValue")}
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${fieldId}-unit`} className="text-xs">
                    {t("labs.ocr.unitLabel")}
                    <RequiredMark />
                  </Label>
                  <LabUnitInput
                    id={`${fieldId}-unit`}
                    value={row.unit ?? ""}
                    onChange={(unit) => onChange({ ...row, unit })}
                    {...invalidProps(
                      errors?.unitMismatch
                        ? "unitMismatch"
                        : errors?.unitTooLong
                          ? "unitTooLong"
                          : "unit",
                    )}
                  />
                  {fieldError("unit", "labs.ocr.errorUnit")}
                  {fieldError("unitTooLong", "labs.ocr.errorTooLong", {
                    max: String(OCR_UNIT_MAX),
                  })}
                  {fieldError("unitMismatch", ...unitMismatchMessage(row))}
                </div>
              </>
            )}
            <div className="space-y-1">
              <Label htmlFor={`${fieldId}-date`} className="text-xs">
                {t("labs.ocr.dateLabel")}
                <RequiredMark />
              </Label>
              <DateField
                id={`${fieldId}-date`}
                value={row.takenAt ?? ""}
                onChange={(value) =>
                  onChange({ ...row, takenAt: value || null })
                }
                {...invalidProps("date")}
                // The bordered wrapper is the visible control; the input inside
                // it only carries the aria state.
                className={errors?.date ? "border-destructive" : undefined}
              />
              {fieldError("date", "labs.ocr.errorDate")}
            </div>
          </div>

          {/* v1.18.10 (#5) — for a NEW numeric biomarker the reference range below
          becomes the marker's catalog range. Make that consequence visible, and
          flag low range-confidence / a missing range so the user verifies it
          before saving. A calm `secondary` badge, not an alarm. */}
          {isNewNumericMarker ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant={flagRange ? "secondary" : "outline"}>
                <Ruler aria-hidden />
                {flagRange
                  ? t("labs.ocr.rangeVerify")
                  : t("labs.ocr.rangeFromScan")}
              </Badge>
            </div>
          ) : null}

          {!isQualitative ? (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor={`${fieldId}-lo`} className="text-xs">
                  {t("labs.ocr.refLowLabel")}
                </Label>
                <Input
                  id={`${fieldId}-lo`}
                  inputMode="decimal"
                  value={
                    row.referenceLow === null ? "" : String(row.referenceLow)
                  }
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    const parsed = raw === "" ? null : Number(raw);
                    onChange({
                      ...row,
                      referenceLow:
                        parsed !== null && Number.isFinite(parsed)
                          ? parsed
                          : null,
                    });
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${fieldId}-hi`} className="text-xs">
                  {t("labs.ocr.refHighLabel")}
                </Label>
                <Input
                  id={`${fieldId}-hi`}
                  inputMode="decimal"
                  value={
                    row.referenceHigh === null ? "" : String(row.referenceHigh)
                  }
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    const parsed = raw === "" ? null : Number(raw);
                    onChange({
                      ...row,
                      referenceHigh:
                        parsed !== null && Number.isFinite(parsed)
                          ? parsed
                          : null,
                    });
                  }}
                />
              </div>
            </div>
          ) : null}

          {/* The window as the report printed it. Editable, because the human is
          reviewing a transcription: the two bounds above are the derived
          reading of this string, and correcting the string is how a range the
          parser could not read ("bis 5,0", "negativ") still reaches the row
          instead of being dropped. */}
          {!isQualitative ? (
            <div className="space-y-1">
              <Label htmlFor={`${fieldId}-refText`} className="text-xs">
                {t("labs.ocr.refTextLabel")}
              </Label>
              <Input
                id={`${fieldId}-refText`}
                value={row.referenceText ?? ""}
                placeholder={t("labs.ocr.refTextPlaceholder")}
                maxLength={120}
                onChange={(e) => {
                  const raw = e.target.value;
                  onChange({
                    ...row,
                    referenceText: raw.trim() === "" ? null : raw,
                  });
                }}
              />
            </div>
          ) : null}

          {valueUnreadable ? (
            <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <AlertCircle aria-hidden className="h-3.5 w-3.5" />
              {t("labs.ocr.valueUnreadable")}
            </p>
          ) : lowValueConfidence ? (
            <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <AlertCircle aria-hidden className="h-3.5 w-3.5" />
              {t("labs.ocr.lowConfidence")}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

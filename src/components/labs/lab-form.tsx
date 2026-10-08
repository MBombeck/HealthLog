"use client";

import { useActiveRecordName } from "@/hooks/use-record-capabilities";
import { useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DateTimeField } from "@/components/ui/date-time-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { apiGet, apiPost } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import {
  isUnreadableRange,
  parseReferenceRange,
} from "@/lib/labs/parse-reference-range";
import { formatReferenceRange } from "@/lib/labs/reference-range";
import { EncounterSuggestionField } from "@/components/encounters/encounter-suggestion-field";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { BiomarkerForm } from "./biomarker-form";
import { useLabNumber } from "./use-lab-format";
import type {
  BiomarkerDto,
  BiomarkerListResponse,
  LabResultDto,
} from "./types";

const NOTE_MAX_LENGTH = 2000;
const DEFINE_NEW = "__define_new__";

function defaultTakenAtValue() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const local = new Date(now.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

/** Parse a free-text decimal that may use a comma separator. */
function parseDecimal(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** The per-reading fields "Save & add another" decides to keep or clear. */
export interface LabEntryDraft {
  biomarkerId: string;
  value: string;
  valueText: string;
  takenAt: string;
  note: string;
  sourceRange: string;
  visitId: string | null;
}

/**
 * The form after "Save & add another": the reading is cleared, everything that
 * describes the report it came from stays. The draw date and the visit are
 * shared by every value on one report, and the biomarker stays because a run
 * of entries is as often one marker over several dates as several markers on
 * one date; re-picking it each time is what the button exists to avoid.
 *
 * Clearing the biomarker here used to drop the picker out of its controlled
 * state. It kept showing the marker it last held while the form value was
 * empty, so the next save refused with "Pick a biomarker first" under a
 * visibly picked marker.
 */
export function nextEntryAfterKeepOpen(draft: LabEntryDraft): LabEntryDraft {
  return {
    ...draft,
    value: "",
    valueText: "",
    note: "",
    // The next reading has its own printed window.
    sourceRange: "",
  };
}

interface LabFormProps {
  /** When set, the biomarker is pre-selected and locked (add-from-detail). */
  lockedBiomarkerId?: string;
  onSuccess?: (created: LabResultDto) => void;
  onCancel?: () => void;
  /**
   * v1.30.1 (H3 QoL fix) — "Save & add another": the sheet stays open, the
   * reading is cleared for the next entry, and `takenAt` is PRESERVED (a
   * real lab report is 10-20 analytes sharing one blood-draw date, usually
   * in the past — re-picking that date for every row was the pain point).
   * Optional and additive: the second button only renders when the caller
   * wires this up, so a consumer that never passes it keeps the single-Save
   * form unchanged. The caller's only job is invalidating the list read —
   * the form itself, not the caller, owns the "stay open + reset" behaviour.
   */
  onSavedKeepOpen?: (created: LabResultDto) => void;
  /**
   * When mounted inside a `<ResponsiveSheet>` the caller passes the sheet's
   * footer slot element here. The Cancel / Save action row is portalled into
   * it so the bottom-sheet branch can sticky-pin it above the keyboard; the
   * Save button stays tied to the `<form>` via the HTML `form` attribute so
   * submit-on-Enter and portalled-click both still submit.
   */
  footerSlot?: HTMLElement | null;
}

/**
 * v1.18.1 — structured lab-result entry.
 *
 * The error-prone free-text path is gone: the user PICKS a biomarker from the
 * catalog, then enters only the value against its known unit + reference range
 * (resolved server-side). A "+ define new" row opens the marker-definition
 * sheet inline and returns with it selected. Panel / unit / range are NOT
 * re-entered per reading — they live on the biomarker. Only the per-reading
 * note stays optional here.
 */
export function LabForm({
  lockedBiomarkerId,
  onSuccess,
  onCancel,
  onSavedKeepOpen,
  footerSlot,
}: LabFormProps) {
  const { t } = useTranslations();
  const labNumber = useLabNumber();
  const recordName = useActiveRecordName();
  const queryClient = useQueryClient();
  const formId = useId();

  const { data: catalog, isLoading: catalogLoading } = useQuery({
    queryKey: queryKeys.biomarkers(),
    queryFn: () => apiGet<BiomarkerListResponse>("/api/biomarkers"),
  });

  const [biomarkerId, setBiomarkerId] = useState<string>(
    lockedBiomarkerId ?? "",
  );
  // v1.18.9 — numeric vs qualitative result mode. Numeric mode enters a number
  // against the marker's unit/range; qualitative mode enters a result text
  // ("negativ" / "positiv" / "grenzwertig" / free text) and hides unit/range.
  const [resultType, setResultType] = useState<"numeric" | "qualitative">(
    "numeric",
  );
  const [value, setValue] = useState("");
  const [valueText, setValueText] = useState("");
  const [takenAt, setTakenAt] = useState(defaultTakenAtValue);
  /**
   * The visit this reading came out of, when the suggestion offered one.
   *
   * Deliberately NOT cleared by the keep-open reset below: a real lab report
   * shares one draw date and one visit across every analyte, so the next row
   * off the same report keeps both rather than asking again.
   */
  const [visitId, setVisitId] = useState<string | null>(null);
  // The `DateTimeField` value is a local `yyyy-MM-ddTHH:mm`; the suggestion
  // asks the server in ISO-8601, so it is converted once here rather than in
  // the shared field, which must not know about this form's input format.
  const takenAtAnchor = useMemo(() => {
    const parsed = new Date(takenAt);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }, [takenAt]);
  const [note, setNote] = useState("");
  // The window the paper report printed for THIS reading. Optional and folded
  // away by default: most entries are typed against a catalog marker and never
  // need it, and a field nobody fills is a field in the way. One text input,
  // because that is how a report states it — "3,5 - 5,0", "< 5", "bis 5,0".
  // The bounds are derived from what is typed; what is typed is kept verbatim.
  const [sourceRangeOpen, setSourceRangeOpen] = useState(false);
  const [sourceRange, setSourceRange] = useState("");
  // v1.30.1 H3 — which submit button is in flight, so the OTHER one doesn't
  // also show a spinner. `!== null` replaces the old plain `submitting`
  // boolean for every disabled check below.
  const [pendingAction, setPendingAction] = useState<
    "save" | "saveAndAddAnother" | null
  >(null);
  const submitting = pendingAction !== null;
  const [error, setError] = useState<string | null>(null);
  const [defineOpen, setDefineOpen] = useState(false);
  const [defineFooterEl, setDefineFooterEl] = useState<HTMLDivElement | null>(
    null,
  );

  const allMarkers = catalog?.biomarkers ?? [];
  const selected = allMarkers.find((m) => m.id === biomarkerId);
  // v1.22 — hidden markers drop from the picker, but keep the currently
  // selected one visible (e.g. editing a reading whose marker was later
  // hidden) so the Select still resolves its label.
  const markers = allMarkers.filter((m) => !m.hidden || m.id === biomarkerId);

  function handleSelect(next: string) {
    if (next === DEFINE_NEW) {
      setDefineOpen(true);
      return;
    }
    setBiomarkerId(next);
    setError(null);
  }

  function afterDefine(created: BiomarkerDto) {
    setDefineOpen(false);
    queryClient.invalidateQueries({ queryKey: queryKeys.biomarkers() });
    setBiomarkerId(created.id);
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    // v1.30.1 H3 — both Save and Save & add another are `type="submit"`
    // buttons tied to this one `<form>` via the HTML `form` attribute (they
    // render portalled into the sheet's footer, outside the `<form>` tag
    // itself); `submitter` distinguishes which one fired this submit.
    const submitter = (e.nativeEvent as SubmitEvent)
      .submitter as HTMLButtonElement | null;
    const keepOpen =
      onSavedKeepOpen != null &&
      submitter?.dataset.action === "save-and-add-another";

    if (!biomarkerId) {
      setError(t("labs.form.pickBiomarkerError"));
      return;
    }

    const isQualitative = resultType === "qualitative";
    let numericValue: number | null = null;
    let qualitativeValue: string | null = null;
    if (isQualitative) {
      const trimmed = valueText.trim();
      if (trimmed === "") {
        setError(t("labs.form.requiredError"));
        return;
      }
      qualitativeValue = trimmed;
    } else {
      numericValue = parseDecimal(value);
      if (numericValue === null) {
        setError(t("labs.form.requiredError"));
        return;
      }
    }

    setPendingAction(keepOpen ? "saveAndAddAnother" : "save");
    try {
      // Parse client-side so the user sees the derived window before saving,
      // and send BOTH: the bounds where they could be read, the text always.
      const printed = isQualitative
        ? null
        : parseReferenceRange(sourceRange, selected?.unit);
      const created = await apiPost<LabResultDto>("/api/labs", {
        biomarkerId,
        ...(isQualitative
          ? { valueText: qualitativeValue }
          : { value: numericValue }),
        ...(printed
          ? {
              ...(printed.low !== null
                ? { sourceReferenceLow: printed.low }
                : {}),
              ...(printed.high !== null
                ? { sourceReferenceHigh: printed.high }
                : {}),
              sourceReferenceText: printed.text,
            }
          : {}),
        takenAt: new Date(takenAt).toISOString(),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(visitId ? { encounterId: visitId } : {}),
      });
      toast.success(
        t("labs.form.savedToast"),
        recordName
          ? {
              description: t("recordSharing.toast.savedTo", {
                name: recordName,
              }),
            }
          : undefined,
      );
      if (keepOpen) {
        const next = nextEntryAfterKeepOpen({
          biomarkerId,
          value,
          valueText,
          takenAt,
          note,
          sourceRange,
          visitId,
        });
        setBiomarkerId(next.biomarkerId);
        setValue(next.value);
        setValueText(next.valueText);
        setTakenAt(next.takenAt);
        setNote(next.note);
        setSourceRange(next.sourceRange);
        setVisitId(next.visitId);
        setError(null);
        onSavedKeepOpen?.(created);
        // The next entry starts at the value, so focus goes there and keeps
        // the flow keyboard/screen-reader friendly across repeated saves.
        document
          .getElementById(
            resultType === "numeric" ? "lab-value" : "lab-valueText",
          )
          ?.focus();
      } else {
        onSuccess?.(created);
      }
    } catch (err) {
      setError(localizedApiError(err, t, "labs.form.saveError"));
    } finally {
      setPendingAction(null);
    }
  }

  const referenceText = selected
    ? formatReferenceRange(selected.lowerBound, selected.upperBound, labNumber)
    : "";

  // What the typed string resolved to, shown back so the user can see whether
  // a window was read out of it before the reading is saved. When none was,
  // the hint says the text is kept as written rather than staying silent.
  const parsedSourceRange = parseReferenceRange(sourceRange, selected?.unit);
  const sourceRangeHint = parsedSourceRange
    ? isUnreadableRange(parsedSourceRange)
      ? t("labs.form.sourceRangeUnparsed")
      : `${formatReferenceRange(
          parsedSourceRange.low,
          parsedSourceRange.high,
          labNumber,
        )} ${selected?.unit ?? ""}`.trim()
    : "";

  const footerNode = (
    <>
      {onCancel ? (
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={submitting}
        >
          {t("common.cancel")}
        </Button>
      ) : null}
      {/* v1.30.1 H3 — additive: only renders when the caller wires up
          `onSavedKeepOpen`. `data-action` is how `handleSubmit` tells this
          button apart from the plain Save below via `event.submitter`. */}
      {onSavedKeepOpen ? (
        <Button
          type="submit"
          form={formId}
          variant="outline"
          data-action="save-and-add-another"
          disabled={submitting}
          // Three buttons do not fit one phone-width row: the secondary save
          // takes a row of its own above Cancel + Save instead of pushing
          // Cancel off the left edge of the sheet.
          className="max-md:order-first max-md:w-full"
        >
          {pendingAction === "saveAndAddAnother" ? (
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : null}
          {t("labs.form.saveAndAddAnother")}
        </Button>
      ) : null}
      <Button type="submit" form={formId} disabled={submitting}>
        {pendingAction === "save" ? (
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        ) : null}
        {t("labs.form.save")}
      </Button>
    </>
  );

  return (
    <>
      <form id={formId} onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="lab-biomarker">{t("labs.form.biomarker")}</Label>
          {/* Always controlled: `""` shows the placeholder. Passing
              `undefined` for an empty pick switched the picker to its own
              internal state, which kept displaying the last marker while the
              form held none. */}
          <Select
            value={biomarkerId}
            onValueChange={handleSelect}
            disabled={!!lockedBiomarkerId || catalogLoading}
          >
            <SelectTrigger id="lab-biomarker" className="w-full">
              <SelectValue placeholder={t("labs.form.biomarkerPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {markers.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name} · {m.unit}
                </SelectItem>
              ))}
              {!lockedBiomarkerId ? (
                <SelectItem value={DEFINE_NEW}>
                  {t("labs.form.defineNew")}
                </SelectItem>
              ) : null}
            </SelectContent>
          </Select>
          {markers.length === 0 && !catalogLoading ? (
            <p className="text-muted-foreground text-xs">
              {t("labs.form.noBiomarkersHint")}
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label>{t("labs.form.resultType")}</Label>
          <div className="flex gap-1">
            <Button
              type="button"
              size="sm"
              variant={resultType === "numeric" ? "secondary" : "ghost"}
              className="min-h-11 flex-1 sm:min-h-9"
              onClick={() => setResultType("numeric")}
              aria-pressed={resultType === "numeric"}
            >
              {t("labs.form.numeric")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={resultType === "qualitative" ? "secondary" : "ghost"}
              className="min-h-11 flex-1 sm:min-h-9"
              onClick={() => setResultType("qualitative")}
              aria-pressed={resultType === "qualitative"}
            >
              {t("labs.form.qualitative")}
            </Button>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            {resultType === "numeric" ? (
              <>
                <Label htmlFor="lab-value">
                  {t("labs.form.value")}
                  {selected ? (
                    <span className="text-muted-foreground font-normal">
                      {" "}
                      ({selected.unit})
                    </span>
                  ) : null}
                </Label>
                <Input
                  id="lab-value"
                  inputMode="decimal"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="0.0"
                  required
                />
              </>
            ) : (
              <>
                <Label htmlFor="lab-valueText">
                  {t("labs.form.qualitativeResult")}
                </Label>
                <Input
                  id="lab-valueText"
                  list="lab-qualitative-options"
                  value={valueText}
                  onChange={(e) => setValueText(e.target.value)}
                  placeholder={t("labs.form.qualitativePlaceholder")}
                  maxLength={120}
                  required
                />
                <datalist id="lab-qualitative-options">
                  <option value={t("labs.form.qualNegative")} />
                  <option value={t("labs.form.qualPositive")} />
                  <option value={t("labs.form.qualBorderline")} />
                </datalist>
              </>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lab-takenAt">{t("labs.form.takenAt")}</Label>
            <DateTimeField
              id="lab-takenAt"
              value={takenAt}
              onChange={setTakenAt}
              max={defaultTakenAtValue()}
              required
            />
          </div>
        </div>

        {/* Anchored on the draw date, not on now: backdating a reading moves
            the offer with it. */}
        <EncounterSuggestionField
          anchor={takenAtAnchor}
          value={visitId}
          onChange={setVisitId}
          slot="lab-form-encounter-suggestion"
        />

        {resultType === "numeric" && selected && referenceText ? (
          <p className="text-muted-foreground text-xs">
            {t("labs.referenceLabel")} {referenceText} {selected.unit}
          </p>
        ) : null}

        {resultType === "numeric" ? (
          <div className="space-y-1.5">
            {sourceRangeOpen ? (
              <>
                <Label htmlFor="lab-sourceRange">
                  {t("labs.form.sourceRange")}
                </Label>
                <Input
                  id="lab-sourceRange"
                  value={sourceRange}
                  onChange={(e) => setSourceRange(e.target.value)}
                  placeholder={t("labs.form.sourceRangePlaceholder")}
                  maxLength={120}
                  autoFocus
                />
                <p className="text-muted-foreground text-xs">
                  {sourceRangeHint || t("labs.form.sourceRangeHint")}
                </p>
              </>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground h-auto px-0 text-xs"
                onClick={() => setSourceRangeOpen(true)}
              >
                {t("labs.form.sourceRangeAdd")}
              </Button>
            )}
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="lab-note">{t("labs.form.note")}</Label>
          <Textarea
            id="lab-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("labs.form.notePlaceholder")}
            maxLength={NOTE_MAX_LENGTH}
            rows={2}
          />
        </div>

        {error ? (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}

        {/* When no footer slot is supplied (rare — e.g. a non-sheet host) the
            action row renders inline; inside a sheet it portals into the
            sticky footer. */}
        {footerSlot ? null : (
          <div className="flex justify-end gap-2">{footerNode}</div>
        )}
      </form>

      {footerSlot ? createPortal(footerNode, footerSlot) : null}

      <ResponsiveSheet
        open={defineOpen}
        onOpenChange={setDefineOpen}
        title={t("labs.biomarker.defineTitle")}
        description={t("labs.biomarker.defineDescription")}
        footer={
          <div
            ref={setDefineFooterEl}
            className="flex w-full justify-end gap-2"
          />
        }
      >
        <BiomarkerForm
          footerSlot={defineFooterEl}
          onSuccess={afterDefine}
          onCancel={() => setDefineOpen(false)}
        />
      </ResponsiveSheet>
    </>
  );
}

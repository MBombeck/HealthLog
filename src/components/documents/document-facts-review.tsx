"use client";

/**
 * Review-then-confirm for a document's staged facts, ON the document detail —
 * the UI leg of a server chain that already existed end to end (extract →
 * PENDING `ExtractedFact` → per-fact edit → confirm) but had no control on
 * this surface: the sheet counted observation facts and offered nothing, so a
 * skipped automatic run forced a re-upload through Labs → Scan a report.
 *
 * Three honest states, all docked onto the existing sheet (no new menu item):
 *
 *   - PENDING facts exist → "Review extracted values (N)" opens the inline
 *     review: approve/reject per fact, a low-confidence fact is checked and
 *     saved first (the existing per-fact edit, which clears `needsReview`).
 *   - No facts yet, but the document is filed as a lab result and has stored
 *     extracted text → "Extract lab values" runs the SAME text-structuring
 *     pass the automatic worker uses ({ mode: "stored" }) — reusing the
 *     stored text, never asking for a re-upload — and opens the review.
 *   - Neither → nothing renders; the surface stays calm.
 *
 * HARD RULE: nothing here writes into Labs / conditions / medications on its
 * own. The confirm mutation carries the person's explicit decisions and the
 * server's confirm route remains the only write path. Unchecked values are
 * rejected (stated in the copy); an unverified low-confidence fact gets NO
 * decision and stays pending rather than being silently discarded.
 */
import { useCalendarDate } from "@/hooks/use-calendar-date";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FlaskConical, Loader2, ScanSearch } from "lucide-react";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors/error-toast";

import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MarkerMatchField } from "@/components/labs/marker-match-field";
import type { BiomarkerListResponse } from "@/components/labs/types";
import { apiGet } from "@/lib/api/api-fetch";
import type { DocumentExtractRunResult } from "@/lib/documents/ai-runs/types";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import type {
  ConditionFactData,
  ExtractedFactDto,
  InboundDocumentDetailDto,
  InboundFactEdit,
  MedicationStatementFactData,
  ObservationFactData,
} from "@/lib/validations/inbound-documents";

import { AiRunPhaseNote } from "./document-ai-panels";
import { useDocumentAiErrorText } from "./use-document-assist";
import {
  useConfirmFacts,
  useEditFact,
  useStoredExtract,
} from "./use-document-facts";

/** Map a per-fact commit refusal to its translated sentence. */
function commitFailureKey(reason: string): string {
  switch (reason) {
    case "observation.unitRequired":
      return "documents.review.failUnitRequired";
    case "observation.unitMismatch":
      return "documents.review.failUnitMismatch";
    case "observation.unknownBiomarker":
      return "documents.review.failUnknownBiomarker";
    default:
      return "documents.review.failGeneric";
  }
}

/** The headline line of a fact (what the document stated). */
function factHeadline(fact: ExtractedFactDto): string {
  if (fact.factType === "OBSERVATION") {
    const data = fact.data as ObservationFactData;
    const value =
      typeof data.value === "number"
        ? `${data.value}${data.unit ? ` ${data.unit}` : ""}`
        : (data.valueText ?? "");
    return value ? `${data.label}: ${value}` : data.label;
  }
  if (fact.factType === "CONDITION") {
    return (fact.data as ConditionFactData).label;
  }
  const data = fact.data as MedicationStatementFactData;
  return data.dose ? `${data.name} ${data.dose}` : data.name;
}

/** The date the fact states, if any (YYYY-MM-DD). */
function factDate(fact: ExtractedFactDto): string | null {
  if (fact.factType === "OBSERVATION") {
    return (fact.data as ObservationFactData).effectiveDate;
  }
  if (fact.factType === "CONDITION") {
    return (fact.data as ConditionFactData).onsetDate;
  }
  return (fact.data as MedicationStatementFactData).effectiveDate;
}

/** Build the full edit payload for a fact from its data + the form draft. */
function buildEdit(
  fact: ExtractedFactDto,
  draft: VerifyDraft,
): InboundFactEdit | null {
  if (fact.factType === "OBSERVATION") {
    const data = fact.data as ObservationFactData;
    const label = draft.label.trim();
    if (!label) return null;
    const numeric = draft.value.trim();
    const qualitative = draft.valueText.trim();
    // Numeric XOR qualitative, mirroring the server schema.
    if (numeric && qualitative) return null;
    const value = numeric ? Number(numeric.replace(",", ".")) : null;
    if (numeric && !Number.isFinite(value)) return null;
    return {
      factType: "OBSERVATION",
      label,
      code: data.code,
      codeSystem: data.codeSystem,
      value,
      valueText: qualitative || null,
      unit: draft.unit.trim() || null,
      referenceLow: data.referenceLow,
      referenceHigh: data.referenceHigh,
      referenceText: data.referenceText ?? null,
      effectiveDate: draft.date || null,
    };
  }
  if (fact.factType === "CONDITION") {
    const data = fact.data as ConditionFactData;
    const label = draft.label.trim();
    if (!label) return null;
    return {
      factType: "CONDITION",
      label,
      code: data.code,
      codeSystem: data.codeSystem,
      clinicalStatus: data.clinicalStatus,
      verificationStatus: data.verificationStatus,
      onsetDate: draft.date || null,
    };
  }
  const data = fact.data as MedicationStatementFactData;
  const name = draft.label.trim();
  if (!name) return null;
  return {
    factType: "MEDICATION_STATEMENT",
    name,
    dose: draft.unit.trim() || null,
    rxNormCode: data.rxNormCode,
    atcCode: data.atcCode,
    statusStated: data.statusStated,
    effectiveDate: draft.date || null,
  };
}

interface VerifyDraft {
  /** Observation/condition label, or the medication name. */
  label: string;
  /** Observation numeric value as typed; unused for the other types. */
  value: string;
  /** Observation qualitative result; unused for the other types. */
  valueText: string;
  /** Observation unit, or the medication dose. */
  unit: string;
  /** Effective/onset date (YYYY-MM-DD) or "". */
  date: string;
}

function draftFor(fact: ExtractedFactDto): VerifyDraft {
  if (fact.factType === "OBSERVATION") {
    const data = fact.data as ObservationFactData;
    return {
      label: data.label,
      value: typeof data.value === "number" ? String(data.value) : "",
      valueText: data.valueText ?? "",
      unit: data.unit ?? "",
      date: data.effectiveDate ?? "",
    };
  }
  if (fact.factType === "CONDITION") {
    const data = fact.data as ConditionFactData;
    return {
      label: data.label,
      value: "",
      valueText: "",
      unit: "",
      date: data.onsetDate ?? "",
    };
  }
  const data = fact.data as MedicationStatementFactData;
  return {
    label: data.name,
    value: "",
    valueText: "",
    unit: data.dose ?? "",
    date: data.effectiveDate ?? "",
  };
}

/** One pending fact: include-toggle, stated values, verify-first when low-confidence. */
function FactRow({
  documentId,
  fact,
  checked,
  onCheckedChange,
  failure,
  chosenBiomarkerId,
  onChooseBiomarker,
  markerName,
}: {
  documentId: string;
  fact: ExtractedFactDto;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** A per-fact commit refusal from the last confirm attempt, or null. */
  failure: string | null;
  /** v1.43 — the suggestion the person picked for a lab value, or null. */
  chosenBiomarkerId: string | null;
  onChooseBiomarker: (biomarkerId: string | null) => void;
  /** The account's marker name by id, for the matched marker. */
  markerName: (biomarkerId: string) => string | null;
}) {
  const { t } = useTranslations();
  const calendarDate = useCalendarDate();
  const editFact = useEditFact();
  const [verifying, setVerifying] = useState(false);
  const [draft, setDraft] = useState<VerifyDraft>(() => draftFor(fact));
  const [draftInvalid, setDraftInvalid] = useState(false);

  const date = factDate(fact);
  const typeLabel = t(`documents.review.type.${fact.factType}`);
  const isObservation = fact.factType === "OBSERVATION";

  const saveVerification = () => {
    const edit = buildEdit(fact, draft);
    if (!edit) {
      setDraftInvalid(true);
      return;
    }
    setDraftInvalid(false);
    editFact.mutate(
      { documentId, factId: fact.id, edit },
      {
        onSuccess: () => {
          setVerifying(false);
          // The refetched fact arrives with needsReview cleared; include it —
          // the person just asserted these values.
          onCheckedChange(true);
        },
      },
    );
  };

  return (
    <li
      data-slot="document-fact-row"
      className="border-border space-y-2 rounded-lg border p-3"
    >
      <div className="flex items-start gap-3">
        <Checkbox
          checked={checked}
          onCheckedChange={(state) => onCheckedChange(state === true)}
          disabled={fact.needsReview}
          aria-label={t("documents.review.includeAria", {
            value: factHeadline(fact),
          })}
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium break-words">
            {factHeadline(fact)}
          </p>
          <p className="text-muted-foreground text-xs">
            {typeLabel}
            {date ? `, ${calendarDate(date)}` : ""}
          </p>
          {isObservation &&
          (fact.biomarkerId !== undefined ||
            (fact.suggestions?.length ?? 0) > 0) ? (
            <MarkerMatchField
              matchedName={
                fact.biomarkerId
                  ? (markerName(fact.biomarkerId) ??
                    (fact.data as ObservationFactData).label)
                  : null
              }
              matchKind={fact.matchKind ?? null}
              suggestions={fact.suggestions ?? []}
              chosenId={chosenBiomarkerId}
              onChoose={(suggestion) =>
                onChooseBiomarker(suggestion?.biomarkerId ?? null)
              }
              slot="document-fact-marker"
            />
          ) : null}
          {isObservation && (fact.data as ObservationFactData).referenceText ? (
            <p className="text-muted-foreground text-xs break-words">
              {t("documents.review.statedRange", {
                range: (fact.data as ObservationFactData)
                  .referenceText as string,
              })}
            </p>
          ) : null}
          {fact.provenance.anchored && fact.provenance.sourceText ? (
            <p className="text-muted-foreground text-xs break-words italic">
              “{fact.provenance.sourceText}”
            </p>
          ) : null}
          {failure ? (
            <p role="alert" className="text-destructive text-xs">
              {t(commitFailureKey(failure))}
            </p>
          ) : null}
        </div>
        {fact.needsReview && !verifying ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 shrink-0 sm:min-h-8"
            onClick={() => setVerifying(true)}
          >
            {t("documents.review.verify")}
          </Button>
        ) : null}
      </div>

      {fact.needsReview && !verifying ? (
        <p className="text-warning text-xs">
          {t("documents.review.needsCheck")}
        </p>
      ) : null}

      {verifying ? (
        <div className="space-y-3" data-slot="document-fact-verify">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`fact-label-${fact.id}`}>
                {t("documents.review.fieldName")}
              </Label>
              <Input
                id={`fact-label-${fact.id}`}
                value={draft.label}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, label: e.target.value }))
                }
                maxLength={fact.factType === "MEDICATION_STATEMENT" ? 200 : 300}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`fact-date-${fact.id}`}>
                {t("documents.review.fieldDate")}
              </Label>
              <DateField
                id={`fact-date-${fact.id}`}
                value={draft.date}
                onChange={(value) => setDraft((d) => ({ ...d, date: value }))}
                aria-label={t("documents.review.fieldDate")}
              />
            </div>
            {isObservation ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={`fact-value-${fact.id}`}>
                    {t("documents.review.fieldValue")}
                  </Label>
                  <Input
                    id={`fact-value-${fact.id}`}
                    inputMode="decimal"
                    value={draft.value}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        value: e.target.value,
                        // Numeric XOR qualitative — typing a number clears text.
                        valueText: e.target.value ? "" : d.valueText,
                      }))
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`fact-value-text-${fact.id}`}>
                    {t("documents.review.fieldValueText")}
                  </Label>
                  <Input
                    id={`fact-value-text-${fact.id}`}
                    value={draft.valueText}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        valueText: e.target.value,
                        value: e.target.value ? "" : d.value,
                      }))
                    }
                    maxLength={300}
                  />
                </div>
              </>
            ) : null}
            {isObservation || fact.factType === "MEDICATION_STATEMENT" ? (
              <div className="space-y-1.5">
                <Label htmlFor={`fact-unit-${fact.id}`}>
                  {isObservation
                    ? t("documents.review.fieldUnit")
                    : t("documents.review.fieldDose")}
                </Label>
                <Input
                  id={`fact-unit-${fact.id}`}
                  value={draft.unit}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, unit: e.target.value }))
                  }
                  maxLength={isObservation ? 80 : 120}
                />
              </div>
            ) : null}
          </div>
          {draftInvalid ? (
            <p role="alert" className="text-destructive text-xs">
              {t("documents.review.verifyInvalid")}
            </p>
          ) : null}
          {editFact.isError ? (
            <p role="alert" className="text-destructive text-xs">
              {t("documents.review.verifyFailed")}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-11 sm:min-h-8"
              onClick={() => {
                setVerifying(false);
                setDraftInvalid(false);
                setDraft(draftFor(fact));
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              className="min-h-11 sm:min-h-8"
              onClick={saveVerification}
              disabled={editFact.isPending}
            >
              {editFact.isPending ? (
                <Loader2
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
              ) : null}
              {t("documents.review.verifySave")}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * The staged-facts block of the document detail. Renders the review (pending
 * facts), the stored-text extract action (lab document, nothing staged yet),
 * or nothing. Owner-only: staging and confirming write to the caller's own
 * record, so a delegate never sees these controls.
 */
/**
 * What the person is told when a stored extract finishes. The staged facts
 * arrive with the document refetch the hook starts; the review opens onto
 * them. A long document read in parts may have had a part cut at the
 * provider's output limit or not reached, and then the review is not the
 * whole document.
 */
function announceExtract(
  result: DocumentExtractRunResult,
  t: (key: string) => string,
  openReview: () => void,
): void {
  if (result.factsStaged > 0) openReview();
  else toast.info(t("documents.review.extractEmpty"));
  if (result.incomplete) {
    toast.warning(t("documents.review.extractIncomplete"));
  }
}

/** The review panel's title and how to use it. */
function ReviewHeading() {
  const { t } = useTranslations();
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{t("documents.review.title")}</p>
      <p className="text-muted-foreground text-xs">
        {t("documents.review.hint")}
      </p>
    </div>
  );
}

/**
 * The staged facts may leave part of the document out. Kept on the document
 * by the extraction, so a review opened later says what the notice at the
 * end of the run said.
 */
function ExtractionIncompleteNote() {
  const { t } = useTranslations();
  return (
    <p
      role="note"
      data-slot="document-facts-incomplete"
      className="text-foreground text-sm"
    >
      {t("documents.review.extractIncomplete")}
    </p>
  );
}

export function DocumentFactsSection({
  doc,
  canManage,
  aiEnabled,
  labsModuleEnabled,
}: {
  doc: InboundDocumentDetailDto;
  canManage: boolean;
  aiEnabled: boolean;
  labsModuleEnabled: boolean;
}) {
  const { t, tCount } = useTranslations();
  const storedExtract = useStoredExtract();
  const confirmFacts = useConfirmFacts();
  const aiErrorText = useDocumentAiErrorText();

  const [open, setOpen] = useState(false);
  // Approve-set as explicit state, seeded per fact on first sight: a
  // confident fact starts included, a low-confidence one starts excluded
  // until it is verified (which checks it).
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});
  // v1.43 — the marker the person picked per lab value, keyed by fact.
  const [chosen, setChosen] = useState<Record<string, string | null>>({});
  const hasObservations = doc.facts.some(
    (fact) => fact.factType === "OBSERVATION" && fact.status === "PENDING",
  );
  const markers = useQuery({
    queryKey: queryKeys.biomarkers(),
    queryFn: () => apiGet<BiomarkerListResponse>("/api/biomarkers"),
    enabled: canManage && hasObservations && open,
  });
  const markerName = (id: string) =>
    markers.data?.biomarkers.find((m) => m.id === id)?.name ?? null;

  const pending = doc.facts.filter((fact) => fact.status === "PENDING");
  const approvedCount = doc.facts.filter(
    (fact) => fact.status === "APPROVED",
  ).length;

  if (!canManage) return null;

  const isChecked = (fact: ExtractedFactDto): boolean =>
    included[fact.id] ?? !fact.needsReview;

  const setChecked = (factId: string, checked: boolean) =>
    setIncluded((prev) => ({ ...prev, [factId]: checked }));

  const finishReview = () => {
    // A still-unverified low-confidence fact gets NO decision — it stays
    // pending instead of being silently discarded.
    const decidable = pending.filter((fact) => !fact.needsReview);
    if (decidable.length === 0) return;
    const decisions = decidable.map((fact) => ({
      factId: fact.id,
      action: isChecked(fact) ? ("approve" as const) : ("reject" as const),
      ...(chosen[fact.id] ? { biomarkerId: chosen[fact.id] as string } : {}),
    }));
    confirmFacts.mutate(
      { documentId: doc.id, decisions },
      {
        onSuccess: (result) => {
          setFailures(
            Object.fromEntries(
              result.failed.map((entry) => [entry.factId, entry.reason]),
            ),
          );
          // The outcome module owns the affordance: green only for a run
          // that actually wrote, neutral for an all-rejected review (an
          // honest non-event), a warning when some values were refused.
          if (result.approved.length > 0) {
            toastWrittenOutcome(
              result.failed.length > 0 ? "partial" : "success",
              tCount("documents.review.savedToast", result.approved.length),
            );
          } else if (result.failed.length === 0) {
            toastWrittenOutcome(
              "empty",
              t("documents.review.nothingSavedToast"),
            );
          }
          if (result.failed.length === 0) setOpen(false);
        },
      },
    );
  };

  // The stored-text extract offer: a lab-filed, already-read document with
  // nothing staged and nothing confirmed yet. `alreadyPartlyConfirmed` is the
  // server's refusal once anything is APPROVED, so the offer withdraws then.
  const canExtract =
    labsModuleEnabled &&
    aiEnabled &&
    doc.kind === "LAB_RESULT" &&
    doc.hasContentIndex &&
    doc.status !== "CONFIRMED" &&
    pending.length === 0 &&
    approvedCount === 0;

  if (pending.length === 0 && !canExtract) return null;

  const unverified = pending.filter((fact) => fact.needsReview).length;

  return (
    <div className="space-y-3" data-slot="document-facts-section">
      {pending.length > 0 && doc.extractionIncomplete ? (
        <ExtractionIncompleteNote />
      ) : null}
      {pending.length > 0 ? (
        <>
          {!open ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-slot="document-facts-review-open"
              className="min-h-11 sm:min-h-9"
              onClick={() => setOpen(true)}
            >
              <FlaskConical className="size-4" aria-hidden />
              {tCount("documents.review.open", pending.length)}
            </Button>
          ) : (
            <div
              data-slot="document-facts-review"
              className="border-border bg-muted/30 space-y-3 rounded-lg border p-3 md:p-4"
            >
              <ReviewHeading />
              <ul className="space-y-2">
                {pending.map((fact) => (
                  <FactRow
                    key={fact.id}
                    documentId={doc.id}
                    fact={fact}
                    checked={isChecked(fact)}
                    onCheckedChange={(checked) => setChecked(fact.id, checked)}
                    failure={failures[fact.id] ?? null}
                    chosenBiomarkerId={chosen[fact.id] ?? null}
                    onChooseBiomarker={(id) =>
                      setChosen((prev) => ({ ...prev, [fact.id]: id }))
                    }
                    markerName={markerName}
                  />
                ))}
              </ul>
              {unverified > 0 ? (
                <p className="text-muted-foreground text-xs">
                  {tCount("documents.review.unverifiedNote", unverified)}
                </p>
              ) : null}
              {confirmFacts.isError ? (
                <p role="alert" className="text-destructive text-sm">
                  {t("documents.review.confirmFailed")}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="min-h-11 sm:min-h-8"
                  onClick={() => setOpen(false)}
                >
                  {t("common.close")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  data-slot="document-facts-confirm"
                  className="min-h-11 sm:min-h-8"
                  onClick={finishReview}
                  disabled={
                    confirmFacts.isPending ||
                    pending.every((fact) => fact.needsReview)
                  }
                >
                  {confirmFacts.isPending ? (
                    <Loader2
                      className="size-4 animate-spin motion-reduce:animate-none"
                      aria-hidden
                    />
                  ) : null}
                  {t("documents.review.finish")}
                </Button>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="space-y-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-slot="document-facts-extract"
            className="min-h-11 sm:min-h-9"
            onClick={() =>
              storedExtract.mutate(
                { documentId: doc.id },
                {
                  onSuccess: (result) => {
                    setFailures({});
                    setIncluded({});
                    announceExtract(result, t, () => setOpen(true));
                  },
                  onError: (error) =>
                    showErrorToast(aiErrorText(error), { cause: error }),
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
      )}
    </div>
  );
}

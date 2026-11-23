"use client";

/**
 * v1.43 — a supplement's composition on the medication detail page: what one
 * tablet or capsule contains, and the editor that sets it.
 *
 * The section shows the composition as the server delivered it (labels in
 * the account language, canonical amounts, the amount as entered beside a
 * converted one). The editor is a ResponsiveSheet with one row per nutrient,
 * built from `GET /api/nutrients/catalog`: the units offered are the code's
 * input units, nothing is converted here. A label photo is offered only when
 * the server says the `supplementLabel` capability is available; its
 * proposal fills the rows for the person to check, and nothing is stored
 * until they save.
 */
import { useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Camera, Loader2, Pencil, Plus, Trash2 } from "lucide-react";

import { nutrientUnitLabel } from "@/components/insights/nutrients/unit-label";
import { FieldError } from "@/components/forms/field-error";
import { MedicationDetailSection } from "@/components/medications/medication-detail-section";
import { FieldGroup } from "@/components/ui/field-group";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useAiRunPhase } from "@/hooks/use-ai-run";
import { useAiCapability } from "@/hooks/use-ai-capability";
import { localizedApiError } from "@/lib/api/localized-error";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { parseDecimalEntry } from "@/lib/measurements/entry-units";

import {
  readSupplementLabel,
  saveComposition,
  useNutrientCatalog,
  type MedicationIngredientDto,
  type NutrientCatalogEntryDto,
  type SupplementLabelProposal,
} from "./use-composition";
import { EmptyState } from "@/components/ui/empty-state";
import { FileInput } from "@/components/ui/file-picker";

/** The categories the composition is offered for without being asked. */
export const COMPOSITION_CATEGORIES: ReadonlySet<string> = new Set([
  "VITAMIN",
  "SUPPLEMENT",
]);

interface EditorRow {
  key: number;
  nutrient: string;
  amount: string;
  unit: string;
  /** From a label proposal the model was unsure of. */
  check: boolean;
}

function formatAmount(
  fmt: { number: (v: number, d?: number) => string },
  value: number,
): string {
  // Up to three decimals: 0.025 mg of a trace element must not read as 0.
  // Only as many as the value has, so 100 µg never reads "100.000" (which a
  // German reader takes for a hundred thousand).
  const rounded = Math.round(value * 1000) / 1000;
  const digits = [0, 1, 2, 3].find(
    (d) => Math.abs(rounded * 10 ** d - Math.round(rounded * 10 ** d)) < 1e-9,
  );
  return fmt.number(rounded, digits ?? 3);
}

/** One composition line: "25 µg (1,000 IU)". */
export function IngredientAmount({
  ingredient,
}: {
  ingredient: MedicationIngredientDto;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  return (
    <span className="tabular-nums">
      {formatAmount(fmt, ingredient.amountPerUnit)}{" "}
      {nutrientUnitLabel(ingredient.unit, t)}
      {ingredient.enteredAmount !== null && ingredient.enteredUnit !== null && (
        <span className="text-muted-foreground">
          {" ("}
          {formatAmount(fmt, ingredient.enteredAmount)}{" "}
          {nutrientUnitLabel(ingredient.enteredUnit, t)}
          {")"}
        </span>
      )}
    </span>
  );
}

function rowsFromIngredients(
  ingredients: ReadonlyArray<MedicationIngredientDto>,
): EditorRow[] {
  return ingredients.map((ingredient, index) => ({
    key: index,
    nutrient: ingredient.nutrient,
    amount: String(ingredient.enteredAmount ?? ingredient.amountPerUnit),
    unit: ingredient.enteredUnit ?? ingredient.unit,
    check: false,
  }));
}

function CompositionEditor({
  medicationId,
  ingredients,
  open,
  onOpenChange,
  labelReadable,
}: {
  medicationId: string;
  ingredients: ReadonlyArray<MedicationIngredientDto>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  labelReadable: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const formId = useId();
  const catalog = useNutrientCatalog(open);
  const entries = (catalog.data?.entries ?? []).filter((e) => e.ingredient);
  const byCode = new Map(entries.map((entry) => [entry.code, entry]));

  const [rows, setRows] = useState<EditorRow[]>(() =>
    rowsFromIngredients(ingredients),
  );
  const [nextKey, setNextKey] = useState(ingredients.length);
  const [source, setSource] = useState<"MANUAL" | "LABEL_AI">("MANUAL");
  const [proposal, setProposal] = useState<SupplementLabelProposal | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const runPhase = useAiRunPhase();

  const chosen = new Set(rows.map((row) => row.nutrient).filter(Boolean));

  function update(key: number, patch: Partial<EditorRow>) {
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  }

  function addRow() {
    setRows((current) => [
      ...current,
      { key: nextKey, nutrient: "", amount: "", unit: "", check: false },
    ]);
    setNextKey((key) => key + 1);
  }

  function chooseNutrient(key: number, code: string) {
    const entry = byCode.get(code);
    update(key, { nutrient: code, unit: entry?.unit ?? "", check: false });
  }

  async function readLabel(file: File) {
    setReading(true);
    setError(null);
    try {
      const read = await readSupplementLabel(queryClient, medicationId, file, {
        onQueued: runPhase.onQueued,
        onProgress: runPhase.onProgress,
      });
      setProposal(read);
      setSource("LABEL_AI");
      setRows(
        read.ingredients.map((line, index) => ({
          key: nextKey + index,
          nutrient: line.nutrient,
          amount: String(line.amount),
          unit: line.unit,
          check: line.confidence === "low",
        })),
      );
      setNextKey((key) => key + read.ingredients.length);
    } catch (err) {
      showErrorToast(
        localizedApiError(err, t, "medications.composition.labelError"),
        { cause: err },
      );
    } finally {
      setReading(false);
      runPhase.reset();
    }
  }

  async function save() {
    if (saving) return;
    const parsed = rows.map((row) => ({
      nutrient: row.nutrient,
      amount: parseDecimalEntry(row.amount),
      unit: row.unit,
    }));
    if (
      parsed.some(
        (row) => !row.nutrient || !row.unit || !(row.amount && row.amount > 0),
      )
    ) {
      setError(t("medications.composition.invalidRow"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveComposition(
        queryClient,
        medicationId,
        parsed.map((row) => ({
          nutrient: row.nutrient,
          amount: row.amount as number,
          unit: row.unit,
        })),
        source,
      );
      onOpenChange(false);
    } catch (err) {
      setError(localizedApiError(err, t, "medications.composition.saveError"));
    } finally {
      setSaving(false);
    }
  }

  const busy = saving || reading;

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("medications.composition.sheetTitle")}
      description={t("medications.composition.sheetDescription")}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => void save()}
            disabled={busy || catalog.isLoading}
            data-slot="medication-composition-save"
          >
            {saving && (
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
            )}
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-slot="medication-composition-editor">
        {labelReadable && (
          <div className="space-y-2">
            <FileInput
              ref={fileInput}
              // No HEIC: a phone browser then hands over a JPEG.
              accept="image/jpeg,image/png,image/webp,application/pdf"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void readLabel(file);
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-9"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
              data-slot="medication-composition-label-photo"
            >
              {reading ? (
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <Camera aria-hidden="true" className="size-4" />
              )}
              {reading
                ? t("medications.composition.labelReading")
                : t("medications.composition.labelPhoto")}
            </Button>
            {reading && runPhase.phase === "waitingForWorker" && (
              <p className="text-muted-foreground text-xs" role="status">
                {t("medications.composition.labelWaiting")}
              </p>
            )}
          </div>
        )}

        {proposal && (
          <div
            className="space-y-1 text-sm"
            data-slot="medication-composition-proposal"
          >
            <p>{t("medications.composition.labelReviewNote")}</p>
            {proposal.servingNote && (
              <p className="text-muted-foreground text-xs">
                {t("medications.composition.servingNote", {
                  note: proposal.servingNote,
                })}
              </p>
            )}
            {proposal.unmatched.length > 0 && (
              <div className="text-xs">
                <p className="text-muted-foreground">
                  {t("medications.composition.unmatchedTitle")}
                </p>
                <ul className="list-disc ps-4">
                  {proposal.unmatched.map((line, index) => (
                    <li key={index}>{line.printedText}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {rows.length === 0 && (
          <p className="text-muted-foreground text-sm">
            {t("medications.composition.editorEmpty")}
          </p>
        )}

        <ul className="space-y-4" role="list">
          {rows.map((row) => {
            const entry = byCode.get(row.nutrient);
            const name = entry?.label ?? row.nutrient;
            return (
              <li
                key={row.key}
                className="grid grid-cols-[1fr_auto_auto] items-end gap-x-3 gap-y-2 sm:grid-cols-[2fr_1fr_1fr_auto]"
                data-slot="medication-composition-row"
              >
                <div className="col-span-3 space-y-2 sm:col-span-1">
                  <Label htmlFor={`${formId}-nutrient-${row.key}`}>
                    {t("medications.composition.nutrientLabel")}
                  </Label>
                  <NativeSelect
                    id={`${formId}-nutrient-${row.key}`}
                    value={row.nutrient}
                    onChange={(event) =>
                      chooseNutrient(row.key, event.target.value)
                    }
                    disabled={busy}
                  >
                    <option value="" disabled>
                      {t("medications.composition.choose")}
                    </option>
                    {entries.map((option: NutrientCatalogEntryDto) => (
                      <option
                        key={option.code}
                        value={option.code}
                        disabled={
                          option.code !== row.nutrient &&
                          chosen.has(option.code)
                        }
                      >
                        {option.label}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <FieldGroup
                  htmlFor={`${formId}-amount-${row.key}`}
                  label={t("medications.composition.amountLabel")}
                >
                  <Input
                    id={`${formId}-amount-${row.key}`}
                    inputMode="decimal"
                    value={row.amount}
                    onChange={(event) =>
                      update(row.key, {
                        amount: event.target.value,
                        check: false,
                      })
                    }
                    aria-invalid={row.check || undefined}
                    disabled={busy}
                  />
                </FieldGroup>
                <FieldGroup
                  htmlFor={`${formId}-unit-${row.key}`}
                  label={t("medications.composition.unitLabel")}
                >
                  <NativeSelect
                    id={`${formId}-unit-${row.key}`}
                    value={row.unit}
                    onChange={(event) =>
                      update(row.key, { unit: event.target.value })
                    }
                    disabled={busy || !entry}
                  >
                    {(entry?.inputUnits ?? []).map((option) => (
                      <option key={option.unit} value={option.unit}>
                        {nutrientUnitLabel(option.unit, t)}
                      </option>
                    ))}
                  </NativeSelect>
                </FieldGroup>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
                  onClick={() =>
                    setRows((current) =>
                      current.filter((candidate) => candidate.key !== row.key),
                    )
                  }
                  disabled={busy}
                  aria-label={t("medications.composition.removeRow", {
                    name,
                  })}
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                </Button>
                {row.check && (
                  <p className="text-warning col-span-full text-xs">
                    {t("medications.composition.lowConfidence")}
                  </p>
                )}
              </li>
            );
          })}
        </ul>

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={addRow}
          disabled={busy || catalog.isLoading}
          data-slot="medication-composition-add-row"
        >
          <Plus aria-hidden="true" className="size-4" />
          {t("medications.composition.addRow")}
        </Button>

        <FieldError
          id={`${formId}-error`}
          message={
            error ??
            (catalog.isError
              ? t("medications.composition.catalogError")
              : undefined)
          }
        />
      </div>
    </ResponsiveSheet>
  );
}

/**
 * The composition section on the Übersicht tab. Rendered for a vitamin or a
 * supplement, and for any medication that already has a composition.
 */
export function CompositionSection({
  medicationId,
  ingredients,
  canEdit,
  ownRecord,
}: {
  medicationId: string;
  ingredients: ReadonlyArray<MedicationIngredientDto>;
  canEdit: boolean;
  /** Reading a label is provider work, never offered inside another record. */
  ownRecord: boolean;
}) {
  const { t } = useTranslations();
  const [open, setOpen] = useState(false);
  const labelCapability = useAiCapability("supplementLabel");

  return (
    <MedicationDetailSection
      titleId="medication-composition-heading"
      title={t("medications.composition.title")}
      dataSlot="medication-composition"
      headerExtras={
        canEdit ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 shrink-0 sm:min-h-9"
            onClick={() => setOpen(true)}
            data-slot="medication-composition-edit"
          >
            {ingredients.length > 0 ? (
              <Pencil aria-hidden="true" className="size-4" />
            ) : (
              <Plus aria-hidden="true" className="size-4" />
            )}
            {ingredients.length > 0
              ? t("medications.composition.edit")
              : t("medications.composition.add")}
          </Button>
        ) : undefined
      }
    >
      {ingredients.length === 0 ? (
        <EmptyState
          variant="plain"
          size="compact"
          title={t("medications.composition.empty")}
        />
      ) : (
        <div className="space-y-3">
          <ul className="divide-border/60 divide-y" role="list">
            {ingredients.map((ingredient) => (
              <li
                key={ingredient.nutrient}
                className="flex items-baseline justify-between gap-3 py-2"
                data-slot="medication-composition-ingredient"
              >
                <span>{ingredient.label}</span>
                <IngredientAmount ingredient={ingredient} />
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs">
            {t("medications.composition.perUnitNote")}
          </p>
        </div>
      )}
      {open && (
        <CompositionEditor
          medicationId={medicationId}
          ingredients={ingredients}
          open={open}
          onOpenChange={setOpen}
          labelReadable={ownRecord && labelCapability.available}
        />
      )}
    </MedicationDetailSection>
  );
}

/**
 * The same editor for any other medication, as a row in the Erweitert tab's
 * lifecycle group: the composition is possible for every medication and
 * offered up front only for vitamins and supplements.
 */
export function CompositionRow({
  medicationId,
  ownRecord,
}: {
  medicationId: string;
  ownRecord: boolean;
}) {
  const { t } = useTranslations();
  const [open, setOpen] = useState(false);
  const labelCapability = useAiCapability("supplementLabel");
  return (
    <div
      className="flex items-center justify-between gap-3 py-3"
      data-slot="erweitert-composition-row"
    >
      <div className="space-y-1">
        <p className="text-foreground text-sm font-medium">
          {t("medications.composition.title")}
        </p>
        <p className="text-muted-foreground text-xs">
          {t("medications.composition.rowHelper")}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="min-h-11 shrink-0 sm:min-h-9"
        data-slot="erweitert-composition-add"
      >
        <Plus aria-hidden="true" className="size-4" />
        {t("medications.composition.add")}
      </Button>
      {open && (
        <CompositionEditor
          medicationId={medicationId}
          ingredients={[]}
          open={open}
          onOpenChange={setOpen}
          labelReadable={ownRecord && labelCapability.available}
        />
      )}
    </div>
  );
}

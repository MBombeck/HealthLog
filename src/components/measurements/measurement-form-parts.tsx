"use client";

import type { ReactNode } from "react";

import {
  ChevronsRight,
  Loader2,
  MoreHorizontal,
  Plus,
  RotateCcw,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FieldGroup } from "@/components/ui/field-group";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { glucoseFractionDigits, type GlucoseUnit } from "@/lib/glucose";
import { useTranslations } from "@/lib/i18n/context";

/**
 * The measurement form's action row: the reset menu, Cancel, "Save and next
 * value" when the form offers it, and Save. Both submit buttons name the form
 * by id, so they still submit it when the row is portalled into a sheet's
 * footer slot; `onSaveNext` runs on the click, before the submit it starts.
 * With the second button on a phone, Cancel gives way to it: the sheet's
 * close button and a swipe still cancel.
 */
export function MeasurementFormFooter({
  loading,
  formId,
  onReset,
  onCancel,
  onSaveNext,
  onSave,
}: {
  loading: boolean;
  formId: string;
  onReset: () => void;
  onCancel?: () => void;
  onSaveNext?: () => void;
  /** Runs on a click of the plain Save, before its submit. */
  onSave?: () => void;
}) {
  const { t } = useTranslations();
  return (
    <div className="flex w-full items-center justify-between gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-11"
            disabled={loading}
            aria-label={t("common.moreOptions")}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={onReset}>
            <RotateCcw className="mr-2 h-4 w-4" />
            {t("measurements.formReset")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex items-center gap-2">
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={loading}
            className={onSaveNext ? "max-sm:hidden" : undefined}
          >
            {t("common.cancel")}
          </Button>
        )}
        {onSaveNext && (
          <Button
            type="submit"
            form={formId}
            variant="outline"
            disabled={loading}
            onClick={onSaveNext}
            data-testid="measurement-save-next"
          >
            <ChevronsRight className="size-4" aria-hidden="true" />
            {t("measurements.saveAndNext")}
          </Button>
        )}
        <Button
          type="submit"
          form={formId}
          disabled={loading}
          onClick={onSave}
          data-testid="measurement-save"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}

/**
 * #1367 — the glucose a ketone meter reads from the same drop, beside the
 * ketones. Optional: a meter that reads ketones only leaves it empty. It asks
 * in the account's glucose unit, which the write path converts back to mg/dL.
 */
export function PairedGlucoseField({
  value,
  onChange,
  unit,
  invalid,
  describedBy,
}: {
  value: string;
  onChange: (next: string) => void;
  unit: GlucoseUnit;
  invalid: boolean;
  describedBy?: string;
}) {
  const { t } = useTranslations();
  return (
    <FieldGroup
      htmlFor="paired-glucose"
      label={
        <>
          {t("measurements.pairedGlucoseLabel", { unit })}
          <span className="text-muted-foreground ml-1 font-normal">
            ({t("common.optional")})
          </span>
        </>
      }
      hint={t("measurements.pairedGlucoseHint")}
    >
      <Input
        id="paired-glucose"
        // Not `type="number"`, like the value field: a decimal comma must
        // survive on every engine.
        inputMode="decimal"
        enterKeyHint="next"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={glucoseFractionDigits(unit) > 0 ? "5.3" : "95"}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      />
    </FieldGroup>
  );
}

/**
 * Field label that keeps the "Name (unit)" translation on a single line even
 * in the narrow three-column blood-pressure grid: the metric name truncates if
 * it must, while the unit renders as a small muted affix that never wraps. The
 * label strings stay localised — we split the trailing "(unit)" the catalogue
 * already carries rather than dropping it (so "mmHg" / "bpm" / locale variants
 * like "lpm" survive).
 */
function UnitLabel({ htmlFor, label }: { htmlFor: string; label: string }) {
  const match = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(label);
  const name = match ? match[1] : label;
  const unit = match ? match[2] : null;
  return (
    <Label htmlFor={htmlFor} className="flex items-baseline gap-1">
      <span className="truncate">{name}</span>
      {unit ? (
        <span className="text-muted-foreground shrink-0 text-xs font-normal">
          {unit}
        </span>
      ) : null}
    </Label>
  );
}

/**
 * The blood pressure row: systolic, diastolic and an optional pulse, each
 * placeholder the person's own last reading, and the "Last …" line under
 * the row. Systolic takes the focus when the form opens.
 */
export function BloodPressureFields({
  sys,
  dia,
  pulse,
  onSys,
  onDia,
  onPulse,
  placeholders,
  autoFocus,
  invalid,
  describedBy,
  lastLine,
}: {
  sys: string;
  dia: string;
  pulse: string;
  onSys: (next: string) => void;
  onDia: (next: string) => void;
  onPulse: (next: string) => void;
  placeholders: { sys?: string; dia?: string };
  autoFocus: boolean;
  invalid: boolean;
  describedBy?: string;
  lastLine: ReactNode;
}) {
  const { t } = useTranslations();
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <div className="space-y-2">
        <UnitLabel htmlFor="sys" label={t("measurements.systolicLabel")} />
        <Input
          id="sys"
          type="number"
          inputMode="numeric"
          enterKeyHint="next"
          step="1"
          value={sys}
          onChange={(e) => onSys(e.target.value)}
          placeholder={placeholders.sys}
          autoFocus={autoFocus}
          required
          aria-required="true"
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          min={60}
          max={280}
        />
      </div>
      <div className="space-y-2">
        <UnitLabel htmlFor="dia" label={t("measurements.diastolicLabel")} />
        <Input
          id="dia"
          type="number"
          inputMode="numeric"
          enterKeyHint="next"
          step="1"
          value={dia}
          onChange={(e) => onDia(e.target.value)}
          placeholder={placeholders.dia}
          required
          aria-required="true"
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          min={30}
          max={200}
        />
      </div>
      <div className="space-y-2">
        <UnitLabel htmlFor="puls" label={t("measurements.pulseLabel")} />
        <Input
          id="puls"
          type="number"
          inputMode="numeric"
          enterKeyHint="next"
          step="1"
          value={pulse}
          onChange={(e) => onPulse(e.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          min={30}
          max={220}
        />
      </div>
      {lastLine ? (
        <p className="text-muted-foreground text-xs sm:col-span-3">
          {lastLine}
        </p>
      ) : null}
    </div>
  );
}

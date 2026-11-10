"use client";

import { Loader2, MoreHorizontal, Plus, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FieldGroup } from "@/components/ui/field-group";
import { Input } from "@/components/ui/input";
import { glucoseFractionDigits, type GlucoseUnit } from "@/lib/glucose";
import { useTranslations } from "@/lib/i18n/context";

/**
 * The measurement form's action row: the reset menu, Cancel and Save. The
 * Save button names the form by id, so it still submits it when the row is
 * portalled into a sheet's footer slot.
 */
export function MeasurementFormFooter({
  loading,
  formId,
  onReset,
  onCancel,
}: {
  loading: boolean;
  formId: string;
  onReset: () => void;
  onCancel?: () => void;
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
          >
            {t("common.cancel")}
          </Button>
        )}
        <Button type="submit" form={formId} disabled={loading}>
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

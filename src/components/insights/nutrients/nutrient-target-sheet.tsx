"use client";

import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";

import { ActionMenu } from "@/components/ui/action-pair";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Segmented } from "@/components/ui/segmented";
import { apiPatch } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { formatDecimal } from "@/lib/format-locale";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { parseDecimalEntry } from "@/lib/measurements/entry-units";
import { NUTRIENT_CATALOG, type NutrientCode } from "@/lib/nutrients/catalog";
import { queryKeys } from "@/lib/query-keys";
import type { NutrientPersonalTargetDto } from "./types";

type Direction = NutrientPersonalTargetDto["direction"];

/**
 * The editor behind the nutrients page's header gear: one code's daily amount
 * and whether it is one to reach or one to stay under. Built on the anatomy of
 * the threshold sheet the other insights pages open from the same gear
 * (`TargetEditSheet`): a `ResponsiveSheet`, the bounds under the field, an
 * inline `role="alert"` line when the entry is out of bounds, and the footer
 * remove | Cancel | Save with the confirmed remove on the left and Save last.
 *
 * The field reads the decimal comma (`parseDecimalEntry`) and opens on the
 * stored amount written the reader's way without grouping ("82,5", "2150"),
 * which the parser reads back. The amount is in the code's canonical unit;
 * the plausibility cap is the server's own bound, so the sheet refuses
 * exactly what the PATCH would.
 */
export function NutrientTargetSheet({
  code,
  name,
  unit,
  windowDays,
  current,
  onOpenChange,
}: {
  code: NutrientCode;
  name: string;
  unit: string;
  windowDays: number;
  current: NutrientPersonalTargetDto | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();
  const formId = useId();
  const inputId = useId();
  const hintId = useId();
  const max = NUTRIENT_CATALOG[code].plausibleDailyMax;

  const seedValue = current ? formatDecimal(current.value, locale, 1) : "";
  const seedDirection: Direction = current?.direction ?? "target";
  const [value, setValue] = useState(seedValue);
  const [direction, setDirection] = useState<Direction>(seedDirection);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const parsed = parseDecimalEntry(value);
  const empty = value.trim() === "";
  const valid = parsed !== null && parsed > 0 && parsed <= max;
  const dirty = value !== seedValue || direction !== seedDirection;

  const mutation = useMutation({
    mutationFn: (next: NutrientPersonalTargetDto | null) =>
      apiPatch("/api/nutrients/targets", { targets: { [code]: next } }),
    onSuccess: async () => {
      // The daily series carries the target; it is the one read to refresh.
      await queryClient.invalidateQueries({
        queryKey: queryKeys.nutrientDaily(code, windowDays),
      });
      onOpenChange(false);
    },
    onError: (cause) => {
      setError(localizedApiError(cause, t, "nutrients.macros.saveFailed"));
    },
  });
  const busy = mutation.isPending;

  return (
    <ResponsiveSheet
      open
      onOpenChange={onOpenChange}
      dirty={dirty && !busy}
      title={t("nutrients.macros.sheetTitle", { name })}
      description={t("nutrients.macros.sheetDescription")}
      className="sm:max-w-md"
      footer={
        <>
          {current ? (
            // Neutral like the threshold sheet's reset: the chart goes back
            // to the reference, and a new target is one save away.
            <ActionMenu disabled={busy} slot="nutrients-target-more">
              <DropdownMenuItem onClick={() => setConfirmReset(true)}>
                <RotateCcw className="mr-2 size-4" />
                {t("nutrients.macros.clearTarget")}
              </DropdownMenuItem>
            </ActionMenu>
          ) : null}
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={!valid || busy}
            data-slot="nutrients-target-save"
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="space-y-4"
        data-slot="nutrients-target-sheet"
        data-nutrient={code}
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || parsed === null) return;
          setError(null);
          mutation.mutate({ value: parsed, direction });
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor={inputId}>
            {t("nutrients.macros.targetLabel", { name, unit })}
          </Label>
          <Input
            id={inputId}
            inputMode="decimal"
            autoComplete="off"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-invalid={!empty && !valid}
            aria-describedby={hintId}
            disabled={busy}
            data-slot="nutrients-target-input"
          />
          {/* The bounds are the hint and, once the entry breaks them, the
              error: in the slot under the field, not under the toggle below
              it. */}
          <p
            id={hintId}
            aria-live="polite"
            data-slot={
              !empty && !valid ? "nutrients-target-validation" : undefined
            }
            className={
              !empty && !valid
                ? "text-destructive text-xs"
                : "text-muted-foreground text-xs"
            }
          >
            {t("nutrients.macros.boundsHint", {
              max: fmt.integer(max),
              unit,
            })}
          </p>
        </div>
        <div className="space-y-1.5">
          <p className="pl-1 text-sm font-medium" aria-hidden="true">
            {t("nutrients.macros.directionLabel")}
          </p>
          <Segmented
            mode="toggle"
            size="sm"
            options={[
              { value: "target", label: t("nutrients.macros.directionTarget") },
              { value: "limit", label: t("nutrients.macros.directionLimit") },
            ]}
            value={direction}
            onChange={setDirection}
            label={t("nutrients.macros.directionLabel")}
            slot="nutrients-target-direction"
          />
        </div>
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
      </form>
      {current ? (
        <ConfirmDialog
          open={confirmReset}
          onOpenChange={setConfirmReset}
          slot="nutrients-target-reset"
          title={t("nutrients.macros.removeTitle")}
          body={t("nutrients.macros.removeBody")}
          confirmLabel={t("nutrients.macros.clearTarget")}
          pending={busy && mutation.variables === null}
          onConfirm={() => mutation.mutate(null)}
        />
      ) : null}
    </ResponsiveSheet>
  );
}

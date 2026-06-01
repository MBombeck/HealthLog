"use client";

import { useMemo } from "react";

import { encodeCadence } from "@/components/medications/scheduling/CadencePicker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type CadenceSubControls,
  type WeekdayToken,
  WEEKDAY_TOKENS,
} from "@/components/medications/scheduling/types";
import { useTranslations } from "@/lib/i18n/context";

import type { StepProps } from "./Step1Name";

/**
 * Step 6 — sub-cadence detail. The body swaps on the cadence kind the
 * user picked in Step 5. Daily and one-shot skip Step 6 entirely (the
 * path table omits the index), so this component only branches on the
 * four kinds that have additional detail: weekdays, everyNWeeks,
 * monthly, rolling.
 *
 * Each branch keeps the `<CadenceSubControls>` shape the picker
 * primitive uses, so the encoded RRULE / rollingIntervalDays the
 * wizard emits matches what the existing edit form would produce for
 * the same inputs.
 */
export function Step6SubCadence({ payload, applyPartial }: StepProps) {
  const { t } = useTranslations();
  const kind = payload.cadence.kind;

  function patchSub(patch: Partial<CadenceSubControls>) {
    const nextSub = { ...payload.subControls, ...patch };
    applyPartial({
      subControls: nextSub,
      cadence: encodeCadence(kind, nextSub),
    });
  }

  if (kind === "weekdays" || kind === "everyNWeeks") {
    return (
      <div className="space-y-3" data-slot="wizard-step6">
        {kind === "everyNWeeks" && (
          <div className="flex items-center gap-2">
            <Label htmlFor="wizard-interval-weeks" className="text-sm">
              {t("medications.wizard.steps.step6.intervalWeeks.label")}
            </Label>
            <Input
              id="wizard-interval-weeks"
              type="number"
              inputMode="numeric"
              min={1}
              max={12}
              value={payload.subControls.intervalWeeks}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 1 && n <= 12) {
                  patchSub({ intervalWeeks: Math.trunc(n) });
                }
              }}
              className="h-11 w-20"
            />
            <span className="text-sm">
              {t("medications.wizard.steps.step6.intervalWeeks.suffix")}
            </span>
          </div>
        )}
        <WeekdayChips
          selected={payload.subControls.weekdays}
          onChange={(weekdays) => patchSub({ weekdays })}
        />
      </div>
    );
  }

  if (kind === "monthly") {
    return (
      <div className="flex items-center gap-2" data-slot="wizard-step6">
        <Label htmlFor="wizard-day-of-month" className="text-sm">
          {t("medications.wizard.steps.step6.dayOfMonth.label")}
        </Label>
        <Input
          id="wizard-day-of-month"
          type="number"
          inputMode="numeric"
          min={1}
          max={31}
          value={payload.subControls.dayOfMonth}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n >= 1 && n <= 31) {
              patchSub({ dayOfMonth: Math.trunc(n) });
            }
          }}
          className="h-11 w-20"
        />
        <span className="text-sm">
          {t("medications.wizard.steps.step6.dayOfMonth.suffix")}
        </span>
      </div>
    );
  }

  if (kind === "rolling") {
    return (
      <div className="flex items-center gap-2" data-slot="wizard-step6">
        <Label htmlFor="wizard-rolling-days" className="text-sm">
          {t("medications.wizard.steps.step6.rollingDays.label")}
        </Label>
        <Input
          id="wizard-rolling-days"
          type="number"
          inputMode="numeric"
          min={1}
          max={365}
          value={payload.subControls.rollingDays}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n >= 1 && n <= 365) {
              patchSub({ rollingDays: Math.trunc(n) });
            }
          }}
          className="h-11 w-20"
        />
        <span className="text-sm">
          {t("medications.wizard.steps.step6.rollingDays.suffix")}
        </span>
      </div>
    );
  }

  return null;
}

interface WeekdayChipsProps {
  selected: readonly WeekdayToken[];
  onChange: (next: WeekdayToken[]) => void;
}

function WeekdayChips({ selected, onChange }: WeekdayChipsProps) {
  const { t } = useTranslations();
  const set = useMemo(() => new Set(selected), [selected]);
  function toggle(tok: WeekdayToken) {
    const next = new Set(set);
    if (next.has(tok)) next.delete(tok);
    else next.add(tok);
    onChange(WEEKDAY_TOKENS.filter((w) => next.has(w)));
  }
  return (
    <div
      role="group"
      aria-label={t("medications.scheduling.cadence.weekdays.label")}
      className="flex flex-wrap gap-1.5"
      data-slot="wizard-weekday-chips"
    >
      {WEEKDAY_TOKENS.map((tok) => {
        const isOn = set.has(tok);
        const short = t(
          `medications.scheduling.cadence.weekdays.short.${tok.toLowerCase()}`,
        );
        const long = t(
          `medications.scheduling.cadence.weekdays.long.${tok.toLowerCase()}`,
        );
        return (
          <button
            key={tok}
            type="button"
            aria-pressed={isOn}
            aria-label={long}
            data-slot="wizard-weekday-chip"
            data-token={tok}
            data-active={isOn ? "true" : "false"}
            onClick={() => toggle(tok)}
            className={[
              "focus-visible:ring-ring inline-flex h-11 min-w-11 items-center justify-center rounded-md border px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2",
              isOn
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border bg-background text-foreground hover:bg-muted",
            ].join(" ")}
          >
            {short}
          </button>
        );
      })}
    </div>
  );
}

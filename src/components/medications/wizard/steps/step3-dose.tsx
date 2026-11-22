"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  INJECTION_SITE_KEYS,
  describeInjectionSite,
  type InjectionSiteKey,
} from "@/lib/medications/injection-sites";
import type { MedicationDeliveryForm } from "@/lib/validations/medication";
import { UnitsPerDoseField } from "@/components/medications/units-per-dose-field";
import { DOSE_UNIT_KEYS } from "@/lib/medications/dose-units";
import { parseUnitsPerDoseInput } from "@/lib/medications/units-per-dose";
import { useTranslations } from "@/lib/i18n/context";

import type { StepProps } from "./step1-name";

const DELIVERY_FORM_KEYS: readonly MedicationDeliveryForm[] = [
  "ORAL",
  "INJECTION",
  "OTHER",
];

/**
 * Units counted from the supply one by one. With one of these the dose
 * itself says how many units a dose takes ("2 tablets"), so the step does not
 * ask "tablets per dose" a second time; with a strength unit (mg, ml, …) it
 * does, because "5 mg" does not say how many tablets that is.
 */
const COUNT_UNITS = new Set([
  "tablets",
  "capsules",
  "drops",
  "puffs",
  "sprays",
  "pieces",
]);

/** The units a counted dose takes from the supply, or null when unreadable. */
function countedUnits(amount: string, unit: string): string | null {
  if (!COUNT_UNITS.has(unit)) return null;
  const value = parseUnitsPerDoseInput(amount.trim());
  return value === null ? null : String(value);
}

/**
 * Step 3: how much one dose is. One question up front (amount and unit, side
 * by side); the route below it, prefilled by the class; the supply details
 * (units per dose for a strength unit, the pack size) are the optional part,
 * and the pack size folds away until somebody wants it.
 */
export function Step3Dose({ payload, applyPartial }: StepProps) {
  const { t } = useTranslations();
  // v1.8.5 — injection-site tracking is a per-medication opt-in surfaced
  // only for an INJECTION delivery form. When enabled, the user can
  // restrict the allowed sites; an empty selection means "no
  // restriction" (every site offered, minus the global exclusion).
  const [allowedOpen, setAllowedOpen] = useState(false);
  const isInjection = payload.deliveryForm === "INJECTION";
  const counted = countedUnits(payload.doseAmount, payload.doseUnit);
  // The counted case carries its unit count in the dose itself; the field
  // only shows when it says something the dose does not (a strength unit,
  // or a stored count that differs from the dose, from an older edit).
  const askUnitsPerDose =
    counted === null ||
    parseUnitsPerDoseInput(payload.unitsPerDose) !== Number(counted);

  function toggleAllowedSite(site: InjectionSiteKey, checked: boolean) {
    const current = new Set(payload.allowedInjectionSites);
    if (checked) current.add(site);
    else current.delete(site);
    applyPartial({
      allowedInjectionSites: INJECTION_SITE_KEYS.filter((s) => current.has(s)),
    });
  }

  // A counted dose sets the units per dose with it, so the supply count
  // follows "2 tablets" without a second question.
  function setDose(doseAmount: string, doseUnit: string) {
    const units = countedUnits(doseAmount, doseUnit);
    applyPartial({
      doseAmount,
      doseUnit,
      ...(units !== null ? { unitsPerDose: units } : {}),
    });
  }

  return (
    <div className="space-y-6" data-slot="wizard-step3">
      <div className="grid grid-cols-2 items-start gap-3">
        <div className="space-y-2">
          <Label htmlFor="wizard-dose-amount" className="text-sm">
            {t("medications.wizard.steps.step3.amountLabel")}
          </Label>
          <Input
            id="wizard-dose-amount"
            type="text"
            inputMode="decimal"
            value={payload.doseAmount}
            onChange={(e) => setDose(e.target.value, payload.doseUnit)}
            placeholder={t("medications.wizard.steps.step3.amountPlaceholder")}
            maxLength={20}
            autoComplete="off"
            enterKeyHint="next"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="wizard-dose-unit" className="text-sm">
            {t("medications.wizard.steps.step3.unitLabel")}
          </Label>
          <Select
            value={payload.doseUnit}
            onValueChange={(v) => setDose(payload.doseAmount, v)}
          >
            <SelectTrigger id="wizard-dose-unit" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DOSE_UNIT_KEYS.map((u) => (
                <SelectItem key={u} value={u}>
                  {t(`medications.wizard.steps.step3.unit.${u}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Units consumed per dose, asked only when the dose does not say it. */}
      {askUnitsPerDose && (
        <UnitsPerDoseBlock
          value={payload.unitsPerDose}
          onChange={(unitsPerDose) => applyPartial({ unitsPerDose })}
        />
      )}

      {/* v1.6.0 — route of administration. Decoupled from the Step 2
          treatment row so an INJECTION delivery surfaces the rotation map
          for any class, not only GLP-1 (which preselects it). */}
      <div className="space-y-2">
        <Label htmlFor="wizard-delivery-form" className="text-sm">
          {t("medications.wizard.steps.step3.deliveryFormLabel")}
        </Label>
        <Select
          value={payload.deliveryForm}
          onValueChange={(v) =>
            applyPartial({ deliveryForm: v as MedicationDeliveryForm })
          }
        >
          <SelectTrigger id="wizard-delivery-form" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DELIVERY_FORM_KEYS.map((d) => (
              <SelectItem key={d} value={d}>
                {t(`medications.wizard.steps.step3.deliveryForm.${d}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <PackSizeField
        value={payload.dosesPerUnit}
        onChange={(dosesPerUnit) => applyPartial({ dosesPerUnit })}
      />

      {/* v1.8.5 — injection-site tracking opt-in + allowed-sites editor.
          Shown only for an INJECTION delivery form. Default off; enabling
          it surfaces the post-dose site prompt and the rotation
          suggestion. The allowed-sites checklist restricts the picker
          (empty = no restriction). */}
      {isInjection && (
        <div
          className="border-border/60 space-y-3 rounded-lg border p-3"
          data-slot="wizard-injection-site"
        >
          <label className="flex items-start justify-between gap-3">
            <span className="space-y-0.5">
              <span className="block text-sm font-medium">
                {t("medications.trackInjectionSitesToggle")}
              </span>
              <span className="text-muted-foreground block text-xs">
                {t("medications.trackInjectionSitesHint")}
              </span>
            </span>
            <Switch
              checked={payload.trackInjectionSites}
              onCheckedChange={(checked) =>
                applyPartial({
                  trackInjectionSites: checked,
                  // Clear the per-med restriction when tracking is turned off.
                  ...(checked ? {} : { allowedInjectionSites: [] }),
                })
              }
              aria-label={t("medications.trackInjectionSitesToggle")}
            />
          </label>

          {payload.trackInjectionSites && (
            <div className="space-y-2">
              <Button
                type="button"
                variant="ghost"
                className="min-h-11 w-full justify-between px-2 sm:min-h-9"
                aria-expanded={allowedOpen}
                onClick={() => setAllowedOpen((prev) => !prev)}
              >
                <span className="text-sm font-medium">
                  {t("medications.allowedSitesLabel")}
                </span>
                {allowedOpen ? (
                  <ChevronUp aria-hidden="true" className="h-4 w-4" />
                ) : (
                  <ChevronDown aria-hidden="true" className="h-4 w-4" />
                )}
              </Button>
              {allowedOpen && (
                <div className="space-y-2 px-1">
                  <p className="text-muted-foreground text-xs">
                    {t("medications.allowedSitesHint")}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {INJECTION_SITE_KEYS.map((site) => {
                      const checked =
                        payload.allowedInjectionSites.includes(site);
                      return (
                        <label
                          key={site}
                          className="flex items-center gap-2 text-sm"
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(c) =>
                              toggleAllowedSite(site, c === true)
                            }
                          />
                          {t(describeInjectionSite(site))}
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Tablets or units per dose, asked when the dose itself does not say it. The
 * inventory counts units (tablets, ampoules); a multi-unit dose (2 × 2 mg for
 * 4 mg) decrements several per take and every dose-level readout divides by
 * this factor. Curated fraction and whole-number buttons (#316), plus an
 * Other field for a whole number and a fraction (1½) up to four decimals
 * (#1034); the step holds while it does not read.
 */
function UnitsPerDoseBlock({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const { t } = useTranslations();
  return (
    <div className="space-y-2" data-slot="wizard-units-per-dose-block">
      <Label id="wizard-units-per-dose-label" className="text-sm">
        {t("medications.wizard.steps.step3.unitsPerDoseLabel")}
      </Label>
      <UnitsPerDoseField
        value={value}
        onChange={onChange}
        labelId="wizard-units-per-dose-label"
        inputId="wizard-units-per-dose-other"
        dataSlot="wizard-units-per-dose"
      />
      <p className="text-muted-foreground text-xs">
        {t("medications.wizard.steps.step3.unitsPerDoseHint")}
      </p>
    </div>
  );
}

/**
 * The pack size belongs to the supply, not the dose: optional, folded away
 * until opened, and open from the start when one is set.
 */
function PackSizeField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const { t } = useTranslations();
  const [open, setOpen] = useState(value !== "");
  return (
    <div className="space-y-2" data-slot="wizard-pack-size">
      <Button
        type="button"
        variant="ghost"
        className="min-h-11 w-full justify-between px-2 sm:min-h-9"
        aria-expanded={open}
        aria-controls="wizard-pack-size-body"
        onClick={() => setOpen((prev) => !prev)}
        data-slot="wizard-pack-size-toggle"
      >
        <span className="text-sm font-medium">
          {t("medications.wizard.steps.step3.packSizeToggle")}
        </span>
        {open ? (
          <ChevronUp aria-hidden="true" className="h-4 w-4" />
        ) : (
          <ChevronDown aria-hidden="true" className="h-4 w-4" />
        )}
      </Button>
      {open && (
        <div id="wizard-pack-size-body" className="space-y-2 px-1">
          <Label htmlFor="wizard-doses-per-unit" className="text-sm">
            {t("medications.wizard.steps.step3.dosesPerUnitLabel")}
          </Label>
          <Input
            id="wizard-doses-per-unit"
            type="text"
            inputMode="numeric"
            value={value}
            // The pack-size cap is 1000, so four digits.
            onChange={(e) =>
              onChange(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))
            }
            placeholder={t(
              "medications.wizard.steps.step3.dosesPerUnitPlaceholder",
            )}
            maxLength={4}
            autoComplete="off"
          />
          <p className="text-muted-foreground text-xs">
            {t("medications.wizard.steps.step3.dosesPerUnitHint")}
          </p>
        </div>
      )}
    </div>
  );
}

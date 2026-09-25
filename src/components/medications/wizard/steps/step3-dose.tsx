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
import { useTranslations } from "@/lib/i18n/context";

import type { StepProps } from "./step1-name";

const DELIVERY_FORM_KEYS: readonly MedicationDeliveryForm[] = [
  "ORAL",
  "INJECTION",
  "OTHER",
];

export function Step3Dose({ payload, applyPartial }: StepProps) {
  const { t } = useTranslations();
  // v1.8.5 — injection-site tracking is a per-medication opt-in surfaced
  // only for an INJECTION delivery form. When enabled, the user can
  // restrict the allowed sites; an empty selection means "no
  // restriction" (every site offered, minus the global exclusion).
  const [allowedOpen, setAllowedOpen] = useState(false);
  const isInjection = payload.deliveryForm === "INJECTION";

  function toggleAllowedSite(site: InjectionSiteKey, checked: boolean) {
    const current = new Set(payload.allowedInjectionSites);
    if (checked) current.add(site);
    else current.delete(site);
    applyPartial({
      allowedInjectionSites: INJECTION_SITE_KEYS.filter((s) => current.has(s)),
    });
  }

  return (
    <div className="space-y-6" data-slot="wizard-step3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="wizard-dose-amount" className="text-sm">
            {t("medications.wizard.steps.step3.amountLabel")}
          </Label>
          <Input
            id="wizard-dose-amount"
            type="text"
            inputMode="decimal"
            value={payload.doseAmount}
            onChange={(e) => applyPartial({ doseAmount: e.target.value })}
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
            onValueChange={(v) => applyPartial({ doseUnit: v })}
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

      {/* v1.6.0 — route of administration + inventory. Decoupled from
          the Step 2 treatment row so an INJECTION delivery surfaces the
          rotation map for any class, not only GLP-1. */}
      <div className="grid grid-cols-2 gap-3">
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
        <div className="space-y-2">
          <Label htmlFor="wizard-doses-per-unit" className="text-sm">
            {t("medications.wizard.steps.step3.dosesPerUnitLabel")}
          </Label>
          <Input
            id="wizard-doses-per-unit"
            type="text"
            inputMode="numeric"
            value={payload.dosesPerUnit}
            onChange={(e) =>
              applyPartial({
                // v1.16.10 — the cap rose to 1000, so four digits.
                dosesPerUnit: e.target.value.replace(/[^0-9]/g, "").slice(0, 4),
              })
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
      </div>

      {/* v1.16.10 — units consumed per dose. The inventory counts units
          (tablets / ampoules); a multi-unit dose (2 × 2 mg for 4 mg)
          decrements several per take and every dose-level readout
          divides by this factor. */}
      <div className="space-y-2">
        <Label id="wizard-units-per-dose-label" className="text-sm">
          {t("medications.wizard.steps.step3.unitsPerDoseLabel")}
        </Label>
        {/* v1.16.12 (#316) — curated fraction / whole-number buttons, the
            most error-resistant input for the common doses. #1034 — plus an
            Other field for a whole number and a fraction (1½) or any other
            value up to four decimals; the step holds while it does not read.
            The decimal value is what the payload + API carry; the button
            shows the glyph. */}
        <UnitsPerDoseField
          value={payload.unitsPerDose}
          onChange={(next) => applyPartial({ unitsPerDose: next })}
          labelId="wizard-units-per-dose-label"
          inputId="wizard-units-per-dose-other"
          dataSlot="wizard-units-per-dose"
        />
        <p className="text-muted-foreground text-xs">
          {t("medications.wizard.steps.step3.unitsPerDoseHint")}
        </p>
      </div>

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

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
import { InjectionSitePicker } from "@/components/medications/injection-site-picker";
import type { InjectionSiteKey } from "@/lib/medications/injection-sites";
import type { MedicationDeliveryForm } from "@/lib/validations/medication";
import { useTranslations } from "@/lib/i18n/context";

import type { StepProps } from "./Step1Name";

/**
 * Dose unit choices, ordered so mg / ml / IE / µg lead and the
 * device-form units (Tablette, Hub, Sprühstoß, …) follow. Mirrors the
 * v1.5.3 list with the Marc-requested order tightening.
 */
const DOSE_UNIT_KEYS = [
  "mg",
  "ml",
  "iu",
  "mcg",
  "g",
  "tablets",
  "capsules",
  "drops",
  "puffs",
  "sprays",
  "pieces",
  "other",
] as const;

const DELIVERY_FORM_KEYS: readonly MedicationDeliveryForm[] = [
  "ORAL",
  "INJECTION",
  "OTHER",
];

export function Step3Dose({ payload, applyPartial }: StepProps) {
  const { t } = useTranslations();
  // The injection-site rotation map is a visual aide on the editor: the
  // chosen site is persisted per intake-event (no medication-level
  // column), so the picker selection here is a local preview the user
  // collapses when not needed.
  const [siteOpen, setSiteOpen] = useState(false);
  const [previewSite, setPreviewSite] = useState<InjectionSiteKey | null>(null);
  const isInjection = payload.deliveryForm === "INJECTION";

  return (
    <div className="space-y-6" data-slot="wizard-step3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
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
            className="h-11"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wizard-dose-unit" className="text-sm">
            {t("medications.wizard.steps.step3.unitLabel")}
          </Label>
          <Select
            value={payload.doseUnit}
            onValueChange={(v) => applyPartial({ doseUnit: v })}
          >
            <SelectTrigger id="wizard-dose-unit" className="h-11 w-full">
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
        <div className="space-y-1.5">
          <Label htmlFor="wizard-delivery-form" className="text-sm">
            {t("medications.wizard.steps.step3.deliveryFormLabel")}
          </Label>
          <Select
            value={payload.deliveryForm}
            onValueChange={(v) =>
              applyPartial({ deliveryForm: v as MedicationDeliveryForm })
            }
          >
            <SelectTrigger id="wizard-delivery-form" className="h-11 w-full">
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
        <div className="space-y-1.5">
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
                dosesPerUnit: e.target.value.replace(/[^0-9]/g, "").slice(0, 3),
              })
            }
            placeholder={t(
              "medications.wizard.steps.step3.dosesPerUnitPlaceholder",
            )}
            maxLength={3}
            autoComplete="off"
            className="h-11"
          />
          <p className="text-muted-foreground text-xs">
            {t("medications.wizard.steps.step3.dosesPerUnitHint")}
          </p>
        </div>
      </div>

      {/* v1.6.0 — collapsible injection-site rotation map. Shown only for
          INJECTION delivery; the per-dose site is logged at intake time
          so this surface is an optional rotation aide, not a persisted
          medication field. */}
      {isInjection && (
        <div
          className="border-border/60 rounded-lg border"
          data-slot="wizard-injection-site"
        >
          <Button
            type="button"
            variant="ghost"
            className="h-11 w-full justify-between px-3"
            aria-expanded={siteOpen}
            onClick={() => setSiteOpen((prev) => !prev)}
          >
            <span className="text-sm font-medium">
              {t("medications.wizard.steps.step3.injectionSiteToggle")}
            </span>
            {siteOpen ? (
              <ChevronUp aria-hidden="true" className="h-4 w-4" />
            ) : (
              <ChevronDown aria-hidden="true" className="h-4 w-4" />
            )}
          </Button>
          {siteOpen && (
            <div className="space-y-2 px-3 pb-4">
              <p className="text-muted-foreground text-xs">
                {t("medications.wizard.steps.step3.injectionSiteHint")}
              </p>
              <InjectionSitePicker
                value={previewSite}
                onChange={setPreviewSite}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

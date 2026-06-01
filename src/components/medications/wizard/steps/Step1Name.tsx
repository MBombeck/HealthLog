"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/lib/i18n/context";

import type { WizardPayload } from "../wizard-payload";

export interface StepProps {
  payload: WizardPayload;
  applyPartial: (partial: Partial<WizardPayload>) => void;
}

export function Step1Name({ payload, applyPartial }: StepProps) {
  const { t } = useTranslations();
  return (
    <div className="space-y-1.5" data-slot="wizard-step1">
      <Label htmlFor="wizard-name" className="sr-only">
        {t("medications.wizard.steps.step1.label")}
      </Label>
      <Input
        id="wizard-name"
        value={payload.name}
        onChange={(e) => applyPartial({ name: e.target.value })}
        placeholder={t("medications.wizard.steps.step1.placeholder")}
        maxLength={100}
        autoCapitalize="words"
        autoComplete="off"
        enterKeyHint="next"
        className="h-11"
      />
    </div>
  );
}

"use client";

import {
  Activity,
  Apple,
  Droplet,
  Flame,
  Leaf,
  type LucideIcon,
  type LucideProps,
  ShieldCheck,
  Stethoscope,
  Syringe,
  Tag,
  Wind,
} from "lucide-react";
import type { ComponentType } from "react";

import { useTranslations } from "@/lib/i18n/context";

import {
  type WizardTreatmentRow,
  WIZARD_TREATMENT_ROWS,
} from "../wizard-payload";
import type { StepProps } from "./Step1Name";

// Each row's Lucide glyph. Marc-confirmed assignment in D-1 §3 Step 2.
const ROW_ICONS: Record<
  WizardTreatmentRow,
  ComponentType<LucideProps>
> = {
  bloodPressure: Stethoscope,
  diabetes: Droplet,
  hormone: Activity,
  glp1: Syringe,
  painRelief: Flame,
  allergy: Wind,
  vitamin: Apple,
  supplement: Leaf,
  antibiotic: ShieldCheck,
  other: Tag as unknown as LucideIcon,
};

export function Step2Class({ payload, applyPartial }: StepProps) {
  const { t } = useTranslations();
  return (
    <div
      role="radiogroup"
      aria-label={t("medications.wizard.steps.step2.title")}
      className="space-y-2"
      data-slot="wizard-step2"
    >
      {WIZARD_TREATMENT_ROWS.map((row) => {
        const Icon = ROW_ICONS[row];
        const selected = payload.treatmentRow === row;
        const label = t(`medications.wizard.classRow.${row}`);
        return (
          <label
            key={row}
            className={[
              "flex min-h-11 cursor-pointer items-center gap-3 rounded-md border p-3 transition-colors",
              selected
                ? "border-primary bg-primary/5"
                : "border-border hover:bg-muted/40",
            ].join(" ")}
            data-slot="wizard-class-row"
            data-row={row}
            data-selected={selected ? "true" : "false"}
          >
            <input
              type="radio"
              name="wizard-class"
              value={row}
              checked={selected}
              onChange={() =>
                applyPartial(
                  // The GLP-1 row is always injected; nudge the
                  // delivery form so the common case needs no extra
                  // tap. The user can still flip it on Step 3.
                  row === "glp1"
                    ? { treatmentRow: row, deliveryForm: "INJECTION" }
                    : { treatmentRow: row },
                )
              }
              className="sr-only"
              aria-label={label}
            />
            <Icon
              className="text-primary h-5 w-5 shrink-0"
              aria-hidden="true"
            />
            <span className="text-sm font-medium">{label}</span>
          </label>
        );
      })}
    </div>
  );
}

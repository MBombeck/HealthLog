"use client";

import {
  Activity,
  Apple,
  BedDouble,
  Brain,
  Droplet,
  Flame,
  Gauge,
  Hand,
  Leaf,
  type LucideIcon,
  type LucideProps,
  ShieldCheck,
  Stethoscope,
  Syringe,
  Tag,
  Utensils,
  Wind,
} from "lucide-react";
import type { ComponentType } from "react";

import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useTranslations } from "@/lib/i18n/context";

import { AddMedicationCategoryRow } from "../../medication-category-add-row";
import { useMedicationCategories } from "../../use-medication-categories";

import {
  type WizardTreatmentRow,
  WIZARD_TREATMENT_ROWS,
} from "../wizard-payload";
import type { StepProps } from "./step1-name";

// Each row's Lucide glyph. maintainer-confirmed assignment in D-1 §3 Step 2.
const ROW_ICONS: Record<WizardTreatmentRow, ComponentType<LucideProps>> = {
  bloodPressure: Stethoscope,
  diabetes: Droplet,
  hormone: Activity,
  glp1: Syringe,
  painRelief: Flame,
  allergy: Wind,
  vitamin: Apple,
  supplement: Leaf,
  antibiotic: ShieldCheck,
  mentalHealth: Brain,
  thyroid: Gauge,
  digestive: Utensils,
  skin: Hand,
  sleepAid: BedDouble,
  other: Tag as unknown as LucideIcon,
};

/** One selectable row: the same anatomy for built-in and custom categories. */
function ClassRow({
  value,
  label,
  Icon,
  selected,
  onSelect,
  slot,
}: {
  value: string;
  label: string;
  Icon: ComponentType<LucideProps>;
  selected: boolean;
  onSelect: () => void;
  slot: "wizard-class-row" | "wizard-custom-class-row";
}) {
  return (
    <label
      className={[
        "flex min-h-11 cursor-pointer items-center gap-3 rounded-md border p-3 transition-colors",
        selected
          ? "border-primary bg-primary/5"
          : "border-border hover:bg-muted/40",
      ].join(" ")}
      data-slot={slot}
      data-row={value}
      data-selected={selected ? "true" : "false"}
    >
      <input
        type="radio"
        name="wizard-class"
        value={value}
        checked={selected}
        onChange={onSelect}
        className="sr-only"
        aria-label={label}
      />
      <Icon className="text-primary h-5 w-5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate text-sm font-medium">{label}</span>
    </label>
  );
}

export function Step2Class({ payload, applyPartial }: StepProps) {
  const { t } = useTranslations();
  const categories = useMedicationCategories();
  // Creating a category is admitted at MANAGE in a shared record.
  const { canManageDomain } = useRecordCapabilities();
  const customKey = payload.customCategoryKey ?? null;
  // Hidden categories leave the picker, except the one this medication is
  // already filed under: an edit must be able to show what it has.
  const customRows = (categories.data ?? []).filter(
    (c) => c.isActive || c.key === customKey,
  );
  return (
    <div
      role="radiogroup"
      aria-label={t("medications.wizard.steps.step2.title")}
      className="space-y-2"
      data-slot="wizard-step2"
    >
      {WIZARD_TREATMENT_ROWS.map((row) => (
        <ClassRow
          key={row}
          value={row}
          label={t(`medications.wizard.classRow.${row}`)}
          Icon={ROW_ICONS[row]}
          selected={payload.treatmentRow === row && customKey === null}
          slot="wizard-class-row"
          onSelect={() =>
            applyPartial(
              // The GLP-1 row is always injected; nudge the
              // delivery form so the common case needs no extra
              // tap. The user can still flip it on Step 3.
              row === "glp1"
                ? {
                    treatmentRow: row,
                    customCategoryKey: null,
                    deliveryForm: "INJECTION",
                  }
                : { treatmentRow: row, customCategoryKey: null },
            )
          }
        />
      ))}
      {customRows.map((c) => (
        <ClassRow
          key={c.key}
          value={c.key}
          label={c.label}
          Icon={Tag as unknown as LucideIcon}
          selected={customKey === c.key}
          slot="wizard-custom-class-row"
          onSelect={() =>
            applyPartial({ treatmentRow: "other", customCategoryKey: c.key })
          }
        />
      ))}
      {canManageDomain("medications") && (
        <AddMedicationCategoryRow
          onCreated={(key) =>
            applyPartial({ treatmentRow: "other", customCategoryKey: key })
          }
        />
      )}
      <p className="text-muted-foreground text-xs">
        {t("medications.category.custom.bpGateNote")}
      </p>
    </div>
  );
}

"use client";

import { encodeCadence } from "@/components/medications/scheduling/CadencePicker";
import type { CadenceKind } from "@/components/medications/scheduling/types";
import { useTranslations } from "@/lib/i18n/context";

import type { WizardPayload } from "../wizard-payload";
import type { StepProps } from "./Step1Name";

/**
 * The six cadence rows surfaced in Step 5. Each maps to a (mode,
 * cadenceKind) decision. "Einmalig" flips the wizard onto the
 * one-shot path; every other row stays recurring.
 */
type Step5Row =
  | "daily"
  | "weekdays"
  | "everyNWeeks"
  | "monthly"
  | "rolling"
  | "oneShot";

const STEP5_ROWS: readonly Step5Row[] = [
  "daily",
  "weekdays",
  "everyNWeeks",
  "monthly",
  "rolling",
  "oneShot",
];

function rowFromPayload(payload: WizardPayload): Step5Row | null {
  if (payload.mode === "oneShot") return "oneShot";
  if (payload.mode === "recurring") {
    switch (payload.cadence.kind) {
      case "daily":
      case "weekdays":
      case "everyNWeeks":
      case "monthly":
      case "rolling":
        return payload.cadence.kind;
      default:
        return null;
    }
  }
  return null;
}

export function Step5Cadence({ payload, applyPartial }: StepProps) {
  const { t } = useTranslations();
  const current = rowFromPayload(payload);
  return (
    <div
      role="radiogroup"
      aria-label={t("medications.wizard.steps.step5.title")}
      className="space-y-2"
      data-slot="wizard-step5"
    >
      {STEP5_ROWS.map((row) => {
        const selected = current === row;
        const label = t(`medications.wizard.cadence.${row}.label`);
        const description = t(`medications.wizard.cadence.${row}.description`);
        return (
          <label
            key={row}
            className={[
              "block min-h-11 cursor-pointer rounded-md border p-3 transition-colors",
              selected
                ? "border-primary bg-primary/5"
                : "border-border hover:bg-muted/40",
            ].join(" ")}
            data-slot="wizard-cadence-row"
            data-row={row}
            data-selected={selected ? "true" : "false"}
          >
            <input
              type="radio"
              name="wizard-cadence"
              value={row}
              checked={selected}
              onChange={() => applyRowPick(row, payload, applyPartial)}
              className="sr-only"
              aria-label={label}
            />
            <div className="text-sm font-medium">{label}</div>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {description}
            </p>
          </label>
        );
      })}
    </div>
  );
}

function applyRowPick(
  row: Step5Row,
  payload: WizardPayload,
  applyPartial: (partial: Partial<WizardPayload>) => void,
) {
  if (row === "oneShot") {
    applyPartial({
      mode: "oneShot",
      cadence: encodeCadence("oneShot", payload.subControls),
      // One-shot pins endsOn to startsOn; the route enforces the
      // same invariant on the server side.
      endsOn: payload.startsOn,
    });
    return;
  }
  const cadenceKind: CadenceKind = row;
  applyPartial({
    mode: "recurring",
    cadence: encodeCadence(cadenceKind, payload.subControls),
  });
}

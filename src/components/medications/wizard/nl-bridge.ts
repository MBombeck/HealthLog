/**
 * v1.5.4 — natural-language extractor → wizard payload adapter.
 *
 * The `NaturalLanguageExtractor` dialog returns a flat partial that
 * mirrors the route's response shape. The wizard's payload splits
 * dose into amount + unit and carries a structured cadence value, so
 * the bridge below maps one onto the other.
 *
 * Lifted from `/medications/new/page.tsx` (v1.5.3) so the modal
 * wizard's dialog can plug the same overlay in without re-deriving
 * the mapping logic.
 */

import { encodeCadence } from "@/components/medications/scheduling/CadencePicker";
import { isoStringToDate } from "@/components/medications/scheduling/CourseWindowRow";
import {
  DEFAULT_SUB_CONTROLS,
  type CadenceSubControls,
  type WeekdayToken,
} from "@/components/medications/scheduling/types";
import type { WizardPayload as ExtractorPayload } from "@/components/medications/scheduling/NaturalLanguageExtractor";

import type { WizardPayload } from "./wizard-payload";

const DOSE_EXPR_RE = /^\s*(\d+(?:[.,]\d+)?)\s*(.*)$/;

function parseDoseExpression(input: string): { amount: string; unit: string } {
  const match = DOSE_EXPR_RE.exec(input.trim());
  if (!match) return { amount: "", unit: input.trim() };
  const amount = match[1] ?? "";
  const unit = (match[2] ?? "").trim();
  return { amount, unit };
}

function subControlsFromExtractor(
  result: Partial<ExtractorPayload>,
): CadenceSubControls {
  const base: CadenceSubControls = { ...DEFAULT_SUB_CONTROLS };
  if (Array.isArray(result.weekdays) && result.weekdays.length > 0) {
    base.weekdays = result.weekdays.filter((w): w is WeekdayToken =>
      ["MO", "TU", "WE", "TH", "FR", "SA", "SU"].includes(w),
    );
  }
  if (typeof result.intervalWeeks === "number") {
    base.intervalWeeks = result.intervalWeeks;
  }
  if (typeof result.intervalMonths === "number") {
    base.intervalMonths = result.intervalMonths;
  }
  if (typeof result.dayOfMonth === "number") {
    base.dayOfMonth = result.dayOfMonth;
  }
  if (typeof result.rollingIntervalDays === "number") {
    base.rollingDays = result.rollingIntervalDays;
  }
  return base;
}

/**
 * Map the extractor's partial payload to a `WizardPayload` partial.
 * One-shot wins over a cadence kind; on a one-shot prefill the
 * adapter clears the `timesOfDay` array so Step 7 (or Step 4 on the
 * one-shot path) forces the user to pick the dose time explicitly
 * rather than inheriting the wizard's 08:00 default.
 */
export function extractorToWizardPartial(
  result: Partial<ExtractorPayload>,
): Partial<WizardPayload> {
  const out: Partial<WizardPayload> = {};

  if (typeof result.name === "string") out.name = result.name;

  if (typeof result.dose === "string") {
    const parsed = parseDoseExpression(result.dose);
    out.doseAmount = parsed.amount;
    if (parsed.unit && !result.doseUnit) {
      out.doseUnit = parsed.unit;
    }
  }
  if (typeof result.doseUnit === "string") {
    out.doseUnit = result.doseUnit;
  }

  if (result.oneShot === true) {
    out.mode = "oneShot";
    out.subControls = subControlsFromExtractor(result);
    out.cadence = encodeCadence("oneShot", out.subControls);
    out.timesOfDay = [];
  } else if (result.cadenceKind) {
    out.mode = "recurring";
    out.subControls = subControlsFromExtractor(result);
    out.cadence = encodeCadence(result.cadenceKind, out.subControls);
  }

  if (
    out.timesOfDay === undefined &&
    Array.isArray(result.timesOfDay) &&
    result.timesOfDay.length > 0
  ) {
    out.timesOfDay = [...result.timesOfDay];
  }

  if (typeof result.startsOn === "string") {
    out.startsOn = isoStringToDate(result.startsOn);
  }
  if (typeof result.endsOn === "string") {
    out.endsOn = isoStringToDate(result.endsOn);
  }
  if (result.oneShot === true && out.startsOn) {
    out.endsOn = out.startsOn;
  }

  return out;
}

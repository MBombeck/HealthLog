/**
 * The one shipped template: what a general doctor's visit usually needs.
 *
 * Nothing applies it on its own. It reaches a selection only when a person
 * presses the button that carries its name, on a panel they are looking at —
 * never on load, never on a stored selection, never on a share link, never on
 * a surface that cannot ask a human. A set that arrives without being asked
 * for is a preselection whatever it is called, and the one thing this release
 * refuses is material in a report nobody ticked.
 *
 * The template intersects the fenced tier at zero leaves, and
 * `catalogue-guard.test.ts` fails the build if that stops being true.
 */
import { type ReportLeafId } from "./catalogue";

/**
 * Identity and insurer (the cover page a practice files the document under),
 * the three classic vitals, weight and BMI, the glucose series and its panel,
 * labs, the drug list and adherence, allergies, past illness episodes, the
 * surgical history and the immunization record.
 *
 * Deliberately not in it: everything a wearable produces, gait and mobility,
 * environment exposure, the per-dose administration ledger (a clinician asks
 * for adherence, not for every logged dose), the GLP-1 block, and the whole
 * fenced tier.
 */
export const STANDARD_TEMPLATE_LEAVES: readonly ReportLeafId[] = [
  "PATIENT_IDENTITY",
  "EMERGENCY",
  "INSURANCE",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
  "WEIGHT",
  "BODY_MASS_INDEX",
  "BLOOD_GLUCOSE",
  "GLUCOSE_PANEL",
  "LAB_RESULTS",
  "MEDICATION_LIST",
  "MEDICATION_COMPLIANCE",
  "ALLERGIES",
  "ILLNESS_EPISODES",
  "SURGICAL_HISTORY",
  "IMMUNIZATIONS",
];

/** The template's i18n label — it is named on the button, never anonymous. */
export const STANDARD_TEMPLATE_LABEL_KEY = "reportSelection.templateStandard";

/**
 * The template as one surface can offer it: the shipped set minus the leaves
 * that surface may not carry (the share-link form hides the insurance leaf,
 * which the server refuses anyway).
 *
 * Pure, so "one click applies exactly the standard set and nothing outside it"
 * is provable without a DOM.
 */
export function standardTemplateFor(
  hiddenLeaves: readonly ReportLeafId[] = [],
): ReportLeafId[] {
  const hidden = new Set(hiddenLeaves);
  return STANDARD_TEMPLATE_LEAVES.filter((leaf) => !hidden.has(leaf));
}

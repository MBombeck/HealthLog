import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * "Not a diagnosis" and "not a cause" are said in one place each.
 *
 * The app used to close dozens of strings with its own version of the same
 * sentence: thirty-one "not a diagnosis" and thirty-one "not a cause", up to
 * three on one page and one per tile. Each statement now has one key under
 * `selfDescription.*`, rendered by the one component, `MedicalDisclaimer`
 * in components/common, once per page or section:
 * every Insights metric page closes with it (`SubPageShell`), and pages about
 * associations carry the `notCause` variant instead.
 *
 * This guard reads the English bundle and fails when any other string says
 * it again. What stays in context on purpose is listed in `IN_CONTEXT`, each
 * with its reason: safety, consent, the standing onboarding floor, and every
 * text that leaves the app, where the reader has none of its context. A
 * listed key that no longer says it fails too, so the list cannot go stale.
 */

const PATTERN =
  /not a diagnos|does not diagnose|doesn't diagnose|not a cause|not causes|not the cause|not medical advice|never a verdict|association only/i;

const CENTRAL = new Set([
  "selfDescription.notDiagnosis",
  "selfDescription.notCause",
]);

const IN_CONTEXT: Record<string, string> = {
  "insights.subPage.explainer.bloodGlucoseBody":
    "Clinical guidance on the ADA thresholds: one high reading needs a repeat test.",
  "insights.breathingScreening.disclaimer":
    "A device screening alert that can be read as a diagnosis (MDR boundary).",
  "settings.glucoseReference.disclaimer":
    "The person picks a clinical reference; the copy states the band is never inferred from a reading.",
  "cycle.prediction.disclaimer":
    "Contraception safety: a prediction is never a method.",
  "cycle.disclaimer": "Contraception safety, kept word for word.",
  "seizures.safety.header":
    "Seizure diary safety: no alarm, follow the agreed emergency plan.",
  "seizures.report.footer": "Printed on the diary that leaves the app.",
  "seizures.report.overlaysNote":
    "Printed on the diary that leaves the app, beside the overlaid factors.",
  "clinicianView.wellness.disclaimer":
    "Shown to a clinician on a share link, outside the app's context.",
};

/**
 * Whole families kept in context: the narrated driver lines feed the Coach
 * prompt and the period narrative too, where they travel without any page and
 * so without the page's note.
 */
const IN_CONTEXT_PREFIXES: Record<string, string> = {
  "insights.correlation.":
    "Driver narration reused in the Coach prompt and the period narrative.",
};

const inContext = (key: string) =>
  key in IN_CONTEXT ||
  Object.keys(IN_CONTEXT_PREFIXES).some((prefix) => key.startsWith(prefix));

function flatten(
  obj: unknown,
  prefix: string,
  out: Map<string, string>,
): Map<string, string> {
  if (obj == null || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else if (typeof v === "object") flatten(v, key, out);
  }
  return out;
}

const en = flatten(
  JSON.parse(readFileSync(join(__dirname, "../../messages/en.json"), "utf8")),
  "",
  new Map(),
);

describe("the medical self-description is said once, centrally", () => {
  it("reads the bundle at all", () => {
    // A sweep over an empty map would pass on nothing.
    expect(en.size).toBeGreaterThan(10_000);
  });

  it("has one key per kind", () => {
    for (const key of CENTRAL) {
      expect(PATTERN.test(en.get(key) ?? ""), key).toBe(true);
    }
  });

  it("is not repeated in any other string", () => {
    const repeats = [...en]
      .filter(([, value]) => PATTERN.test(value))
      .map(([key]) => key)
      .filter((key) => !CENTRAL.has(key) && !inContext(key));
    expect(repeats).toEqual([]);
  });

  it("keeps in context only what still says it", () => {
    const stale = Object.keys(IN_CONTEXT).filter(
      (key) => !PATTERN.test(en.get(key) ?? ""),
    );
    expect(stale).toEqual([]);
    for (const prefix of Object.keys(IN_CONTEXT_PREFIXES)) {
      expect(
        [...en].some(
          ([key, value]) => key.startsWith(prefix) && PATTERN.test(value),
        ),
        prefix,
      ).toBe(true);
    }
  });
});

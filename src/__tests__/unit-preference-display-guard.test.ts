/**
 * Structural guard (a tripwire, not a proof) for the metric/imperial unit
 * fix (issue #627). The dangerous failure mode is a PARTIAL fix: entry converts
 * but a display surface still hardcodes the canonical unit, so an imperial user
 * sees converted-then-mislabelled soup. This walks the dashboard + insight page
 * sources and asserts none of them passes a transformed type's DISPLAY UNIT
 * (kg / lb / cm / in / °C / °F / km/h / mph / km / mi) or a hardcoded value
 * scale as a literal prop — those must resolve from the user's preference
 * through `useUnitDisplay()` instead.
 *
 * Mutation check: add `unit="kg"` back to any swept page and this goes red.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";

import { describe, it, expect } from "vitest";

import {
  getDisplayTransform,
  TRANSFORMED_TYPES,
} from "@/lib/measurements/display-transform";

const SRC = join(process.cwd(), "src");

/** The set of display-unit strings a transformed type can render. */
const TRANSFORMED_UNITS: ReadonlySet<string> = new Set(
  [...TRANSFORMED_TYPES].flatMap((type) => [
    getDisplayTransform(type, "metric").displayUnit,
    getDisplayTransform(type, "imperial").displayUnit,
  ]),
);

/**
 * v1.32.27 — the target/threshold subsystem. These three files are the
 * coupled display+edit unit: the reference panel that RENDERS a target
 * band, the sheet that EDITS it, and the settings editor that edits the
 * same thresholds from the other end. A partial wire here is worse than
 * none — a converted display over a canonical save silently rewrites
 * the user's stored target — so they are swept for hardcoded units AND
 * asserted to route through the preference hook.
 */
const TARGET_SURFACES = [
  join(SRC, "components", "insights", "metric-target-summary.tsx"),
  join(SRC, "components", "targets", "target-edit-sheet.tsx"),
  join(SRC, "components", "settings", "thresholds-editor-section.tsx"),
];

/**
 * v1.32.30 — the profile height surfaces. Height is not a
 * `MeasurementType`, so `display-transform.ts` never reached it and it
 * stayed in centimetres for two releases after everything else moved.
 * These three are the coupled entry unit: the two forms that write
 * `User.heightCm` and the control they share. A partial wire here is
 * the same failure the target block guards against — a converted field
 * over a canonical save silently rewrites the stored height.
 */
/**
 * One entry per surface. A surface is a group of files because the
 * onboarding step keeps the preference and the adapter where the save
 * happens and renders the control from its own inputs file — the three
 * conditions below are asserted across the group, not per file, so
 * splitting a form does not read as an un-wire.
 */
const HEIGHT_SURFACES = [
  [
    join(SRC, "components", "onboarding", "baseline-form.tsx"),
    join(SRC, "components", "onboarding", "baseline-fields.tsx"),
  ],
  [join(SRC, "components", "settings", "account-section", "index.tsx")],
];

const HEIGHT_CONTROL = join(
  SRC,
  "components",
  "profile",
  "height-field-control.tsx",
);

/**
 * Swept surfaces: the dashboard client, every insights sub-page, and the
 * target/threshold surfaces.
 */
function sweptFiles(): string[] {
  return [
    join(SRC, "app", "page-client.tsx"),
    ...walkSourceFiles(SRC, { floor: 700, extensions: [".tsx"] })
      .filter(
        (rel) => rel.startsWith("app/insights/") && rel.endsWith("/page.tsx"),
      )
      .map((rel) => join(SRC, rel)),
    ...TARGET_SURFACES,
  ];
}

describe("unit-preference display guard", () => {
  it("sweeps a non-empty set of surfaces", () => {
    // Guards against a glob that silently matches nothing (a green void).
    expect(sweptFiles().length).toBeGreaterThan(10);
  });

  it("no swept surface hardcodes a transformed type's display unit", () => {
    const offenders: string[] = [];
    for (const file of sweptFiles()) {
      const src = readFileSync(file, "utf8");
      for (const unit of TRANSFORMED_UNITS) {
        // Match `unit="kg"` / `yAxisUnit="°C"` exactly (closing quote pinned so
        // `unit="kg/m²"` — the excluded BMI unit — never trips it).
        for (const prop of ["unit", "yAxisUnit"]) {
          if (src.includes(`${prop}="${unit}"`)) {
            offenders.push(`${file}: ${prop}="${unit}"`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no insights page hardcodes a numeric valueScale literal", () => {
    // Transformed metrics resolve their scale from the transform; a literal
    // `valueScale={3.6}` is the pre-fix hand-rolled scaling that double-scales.
    const literal = /valueScale=\{\s*-?\d/;
    const offenders = sweptFiles().filter((file) =>
      literal.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("every target/threshold surface resolves its unit from the preference", () => {
    // The tripwire for a silent un-wire: delete the hook import from any
    // of the three and the surface falls back to canonical kilograms
    // while its sibling still shows pounds.
    // The call site, not the import — swapping the hook out for a
    // hardcoded "metric" literal while leaving the import behind is
    // exactly the un-wire this has to catch.
    const offenders = TARGET_SURFACES.filter(
      (file) => !readFileSync(file, "utf8").includes("useUnitDisplay()"),
    );
    expect(offenders).toEqual([]);
  });

  it("every target/threshold surface converts through the shared adapter", () => {
    // One adapter owns seed, guardrail, save, and unit label for all
    // three surfaces. A surface that hand-rolls its own conversion (or
    // announces `METRIC_BOUNDS[metric].unit`, the canonical symbol)
    // is how the display and the edit halves drift apart.
    const offenders: string[] = [];
    for (const file of TARGET_SURFACES) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("resolveTargetUnitAdapter")) {
        offenders.push(`${file}: no adapter`);
      }
      if (/METRIC_BOUNDS\[[^\]]+\]\.unit/.test(src)) {
        offenders.push(`${file}: canonical bound unit rendered`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every height entry surface resolves through the profile adapter", () => {
    // Same tripwire as the target block: drop the hook or the adapter
    // from one form and it falls back to centimetres while its sibling
    // shows feet and inches.
    const offenders: string[] = [];
    for (const files of HEIGHT_SURFACES) {
      const surface = files.join(" + ");
      const src = files.map((file) => readFileSync(file, "utf8")).join("\n");
      if (!src.includes("useUnitDisplay()")) {
        offenders.push(`${surface}: no preference hook`);
      }
      if (!src.includes("resolveHeightUnitAdapter")) {
        offenders.push(`${surface}: no height adapter`);
      }
      // Word-bounded: a renamed local wrapper whose name merely starts
      // with the control's satisfies a substring check while rendering
      // something else entirely.
      if (!/\bHeightFieldControl\b/.test(src)) {
        offenders.push(`${surface}: hand-rolled height input`);
      }
      // The canonical centimetre guardrails must come from the
      // adapter's inward-rounded bounds, never from a literal.
      if (/min=\{50\}|max=\{300\}/.test(src)) {
        offenders.push(`${surface}: hardcoded centimetre guardrail`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the height control announces its units from the bundle", () => {
    const src = readFileSync(HEIGHT_CONTROL, "utf8");
    // A quoted "cm" / "ft" / "in" here is a hardcoded unit label; every
    // unit string on this control resolves through `t(...)`.
    expect(src).not.toMatch(/["'](cm|ft|in)["']/);
    expect(src).toContain('t("common.feet")');
    expect(src).toContain('t("common.inches")');
  });

  it("every transformed type carries both a metric and an imperial branch", () => {
    for (const type of TRANSFORMED_TYPES) {
      const metric = getDisplayTransform(type, "metric");
      const imperial = getDisplayTransform(type, "imperial");
      expect(metric.displayUnit).toBeTruthy();
      expect(imperial.displayUnit).toBeTruthy();
      expect(Number.isFinite(metric.factor)).toBe(true);
      expect(Number.isFinite(imperial.factor)).toBe(true);
    }
  });
});

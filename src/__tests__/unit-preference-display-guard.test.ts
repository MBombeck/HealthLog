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
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { stripComments, walkSourceFiles } from "./helpers/source-files";

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

/**
 * The wide sweep (#1067). The block above guards the surfaces that were
 * wired for metric/imperial; the class kept reappearing everywhere else — a
 * clinician view without units, status notes and narratives pinned to mg/dL
 * and kilograms, a glucose threshold editor in mg/dL for an mmol/L account,
 * workout distances in kilometres for an imperial reader. Each one was a
 * unit literal in a display string.
 *
 * So every display-bearing tree is swept for the literals a preference
 * changes: the two glucose units anywhere in code, and kilograms,
 * kilometres and degrees Celsius where they sit in a display string (a bare
 * quoted unit, a unit after an interpolation or a number, a unit closing a
 * string, a per-kilometre pace). Comments are stripped first. A file that
 * legitimately carries one is listed below with the exact number of matching
 * lines and the reason; any other file, or one more line in a listed file,
 * fails. A listed file that drops a line fails too, so the budget follows
 * the code down instead of leaving headroom for the next literal.
 *
 * The text the AI and the Coach write is swept the same way: the prompt and
 * snapshot builders (`lib/ai/`), the jobs that write stored text
 * (`lib/jobs/`), the target and daily-digest producers. A prompt that
 * states a threshold or a band in kilograms, °C or mg/dL hands a reader on
 * pounds, °F or mmol/L two units for one quantity, and the model mixes
 * them. Prose units ("5 metres", "kg/week") are matched as well, because a
 * prompt is prose.
 *
 * The limit, stated: this is a line scanner. A unit spelled through a
 * variable named after it, or a literal split across lines, passes. The
 * message bundles are not swept either (the fever and cycle-glucose labels
 * lived there). The producer check below covers what a scanner cannot: a
 * text producer that prints a canonical number with no unit at all.
 */
const WIDE_SWEEP_ROOTS = [
  "components/",
  "app/",
  "lib/insights/",
  "lib/doctor-report",
  "lib/export",
  "lib/ai/",
  "lib/jobs/",
  "lib/targets/",
  "lib/daily/",
];

const UNIT_LITERAL_PATTERNS: readonly RegExp[] = [
  // Glucose, anywhere in code.
  /mg\/dL|mmol\/L/,
  // A bare quoted unit: "kg", 'km', `°C`.
  /(["'`])\s*(?:kg|km|°C)\s*\1/,
  // A unit after an interpolation: `${x} kg`, {value} km in JSX.
  /\}\s?(?:kg|km|°C)(?![\w/²])/,
  // A unit after a number: "75 kg", "37.0 °C".
  /\d\s?(?:kg|km|°C)(?![\w/²])/,
  // A unit closing a string or a JSX text run: " km<", " kg\"".
  /\s(?:kg|km|°C)(?=["'`<])/,
  // A per-kilometre pace.
  /\/km\b/,
  // A rate per kilogram written into prose: "kg/week" (BMI's kg/m² excepted).
  /\bkg\/(?!m²)/,
  // A unit spelled out after a number or an interpolation: "5 metres".
  /(?:\d|\})\s?(?:metres?|kilograms?)\b/,
];

/**
 * Files allowed to carry a unit literal, with the exact number of matching
 * lines and why. `kg/m²` (BMI) never matches; every other hit is listed.
 */
const UNIT_LITERAL_ALLOWLIST: Record<
  string,
  { lines: number; reason: string }
> = {
  // ── The conversion and the choice themselves ──
  "components/settings/glucose-unit-select.tsx": {
    lines: 2,
    reason: "the glucose unit picker: its options are the two units",
  },
  "components/onboarding/units-screen.tsx": {
    lines: 3,
    reason: "the onboarding unit picker: its options are the two units",
  },
  "components/measurements/measurement-form.tsx": {
    lines: 11,
    reason:
      "input parsing: canonical units of the entry table, replaced by the transform's unit at render and inverted on save",
  },
  "components/measurements/measurement-list.tsx": {
    lines: 2,
    reason: "input parsing: the inline edit inverts an mmol/L entry to mg/dL",
  },
  "components/settings/import-panel/import-examples.ts": {
    lines: 3,
    reason: "input parsing: CSV examples showing the units an import accepts",
  },
  "components/onboarding/first-result-screen.tsx": {
    lines: 1,
    reason: "decimals chosen by the resolved glucose unit, not a label",
  },
  "app/insights/blood-glucose/page.tsx": {
    lines: 1,
    reason: "branches on the resolved glucose unit to scale the chart",
  },
  "components/insights/glucose/glucose-clinical-panel.tsx": {
    lines: 1,
    reason: "branches on the resolved glucose unit for its decimals",
  },
  "components/insights/health-score-pillar-detail.ts": {
    lines: 2,
    reason:
      "branches on the canonical observed unit before converting to the reader's",
  },
  // ── Display-kind tags, converted through the preference at render ──
  "components/cycle/cycle-phase-crosstab.tsx": {
    lines: 1,
    reason: "a display-kind tag; rows convert through getReadingTransform",
  },
  "lib/insights/mood-crosstab.ts": {
    lines: 2,
    reason: "a display-kind tag; the weight row converts through the hook",
  },
  "components/insights/mood/mood-factor-metric-crosstab.tsx": {
    lines: 2,
    reason: "a display-kind tag; the weight row converts through the hook",
  },
  // ── Canonical by contract ──
  "lib/insights/metric-status-registry.ts": {
    lines: 11,
    reason:
      "canonical registry units; metric-status.ts converts to the reader's before writing",
  },
  "lib/export.ts": {
    lines: 1,
    reason: "canonical default when an export caller passes no glucose unit",
  },
  "app/api/export/route.ts": {
    lines: 1,
    reason: "the legacy export endpoint's canonical storage-unit contract",
  },
  "app/api/measurements/series/route.ts": {
    lines: 4,
    reason:
      "canonical wire units; glucose is overridden to the reader's unit per request",
  },
  "lib/doctor-report/stat-display.ts": {
    lines: 3,
    reason:
      "SI by policy: the clinician artefacts keep mass in kg (glucose follows the owner)",
  },
  "components/insights/workout-detail/splits.tsx": {
    lines: 1,
    reason: "kilometre splits are cut server-side; their pace is per km",
  },
  "app/privacy/page.tsx": {
    lines: 2,
    reason: "prose naming both glucose units the app offers",
  },
  // ── The AI and Coach producers ──
  "lib/ai/insight-interpretation.ts": {
    lines: 1,
    reason:
      "canonical band registry; interpretation-block prints the band in the reader's unit",
  },
  "lib/ai/prompts/shared-contracts.ts": {
    lines: 3,
    reason:
      "the acute red-flag floors, stated in both units on purpose so the rule fires on what the person writes",
  },
  "lib/ai/coach/snapshot-blocks/glucose-block.ts": {
    lines: 4,
    reason:
      "branches on the resolved glucose unit; a mg/dL reader's block stays byte-identical",
  },
  "lib/ai/coach/results/chart-spec.ts": {
    lines: 2,
    reason:
      "bin widths keyed to a column unit, applied only when the table is in that unit",
  },
  "lib/ai/coach/coach-prose-grounding.ts": {
    lines: 1,
    reason:
      "the reply checker's list of unit tokens it recognises in model prose",
  },
  "lib/ai/coach/eval/golden-cases.ts": {
    lines: 5,
    reason: "evaluation fixtures: scripted replies and ideal answers",
  },
  "lib/ai/coach/eval/red-team.ts": {
    lines: 2,
    reason: "adversarial evaluation inputs, written as a person would type",
  },
  "lib/targets/target-unit-display.ts": {
    lines: 4,
    reason: "the target adapter itself: picks the glucose branch",
  },
  "lib/targets/vitals-builder.ts": {
    lines: 1,
    reason:
      "canonical targets DTO; every client converts through the target adapter",
  },
};

function unitLiteralLines(): Map<string, string[]> {
  const files = walkSourceFiles(SRC, { floor: 1400 }).filter(
    (rel) =>
      WIDE_SWEEP_ROOTS.some((root) => rel.startsWith(root)) &&
      !rel.includes("__tests__") &&
      !/\.test\.tsx?$/.test(rel),
  );
  if (files.length < 1700) {
    throw new Error(
      `unit sweep narrowed to ${files.length} files; a sweep this small is a broken filter`,
    );
  }
  const hits = new Map<string, string[]>();
  for (const rel of files) {
    const lines = stripComments(readFileSync(join(SRC, rel), "utf8"))
      .split("\n")
      .filter((line) => UNIT_LITERAL_PATTERNS.some((p) => p.test(line)))
      .map((line) => line.trim());
    if (lines.length > 0) hits.set(rel, lines);
  }
  return hits;
}

describe("unit-preference display guard — the wide sweep", () => {
  const hits = unitLiteralLines();

  it("finds the literals it is meant to find (a sweep that matches nothing proves nothing)", () => {
    const total = [...hits.values()].reduce((n, l) => n + l.length, 0);
    expect(total).toBeGreaterThanOrEqual(40);
    expect(hits.size).toBeGreaterThanOrEqual(15);
  });

  it("no display surface carries a unit literal outside the allowlist", () => {
    const offenders: string[] = [];
    for (const [rel, lines] of hits) {
      const allowed = UNIT_LITERAL_ALLOWLIST[rel];
      if (!allowed) {
        offenders.push(`${rel}: ${lines.join(" | ")}`);
      } else if (lines.length > allowed.lines) {
        offenders.push(
          `${rel}: ${lines.length} unit-literal lines, allowlisted ${allowed.lines}: ${lines.join(" | ")}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every allowlist entry still matches exactly its budget, with a reason", () => {
    const stale: string[] = [];
    for (const [rel, allowed] of Object.entries(UNIT_LITERAL_ALLOWLIST)) {
      expect(allowed.reason.length).toBeGreaterThan(10);
      const found = hits.get(rel)?.length ?? 0;
      if (found !== allowed.lines) {
        stale.push(`${rel}: allowlisted ${allowed.lines}, found ${found}`);
      }
    }
    expect(stale).toEqual([]);
  });
});

/**
 * The producers of text a model reads or writes from. A line scanner sees a
 * unit literal; it cannot see a canonical number printed with no unit at
 * all, which is how the Coach's weight block and the briefing's glucose
 * signal reached readers on pounds and mmol/L. So each producer that carries
 * a mass, length, temperature, speed, distance or glucose figure into a
 * prompt, a snapshot or a stored sentence is named here and must call one of
 * the resolvers that state a figure in the reader's units. Dropping the call
 * (or the file) fails.
 */
const READER_UNIT_PRODUCERS = [
  "lib/ai/coach/reference-grounding.ts",
  "lib/ai/coach/snapshot-blocks/core-metrics-block.ts",
  "lib/ai/coach/snapshot-blocks/value-series-blocks.ts",
  "lib/ai/coach/snapshot-blocks/workouts-block.ts",
  "lib/ai/coach/cycle-snapshot.ts",
  "lib/ai/coach/results/metric-table-tool.ts",
  "lib/ai/prompts/weight.ts",
  "lib/insights/features-units.ts",
  "lib/insights/comprehensive-generate.ts",
  "app/api/insights/generate/route.ts",
  "lib/insights/weight-status.ts",
  "lib/insights/metric-status.ts",
  "lib/insights/narrative/period-narrative.ts",
  "lib/insights/glp1-plateau.ts",
  "lib/jobs/reaction-line.ts",
  "lib/targets/weight-trend.ts",
];

const READER_UNIT_RESOLVER =
  /\b(?:getReadingTransform|getQuantityTransform|getDisplayTransform|featuresInReaderUnits|weightFeatureInReaderUnits)\(/;

describe("unit-preference display guard — AI and Coach producers", () => {
  it("names enough producers to be a check (a list that shrinks proves nothing)", () => {
    expect(READER_UNIT_PRODUCERS.length).toBeGreaterThanOrEqual(16);
  });

  it("every producer states its figures through a reader-unit resolver", () => {
    const offenders = READER_UNIT_PRODUCERS.filter(
      (rel) =>
        !READER_UNIT_RESOLVER.test(
          stripComments(readFileSync(join(SRC, rel), "utf8")),
        ),
    );
    expect(offenders).toEqual([]);
  });
});

/**
 * Locale strings that may name a glucose unit literally, each with the reason
 * it is not a reading shown in the reader's unit. Keys are dotted paths and
 * apply to every locale bundle.
 */
const GLUCOSE_UNIT_LITERAL_ALLOWLIST: Record<string, string> = {
  "dashboard.metric.unit.glucose":
    "the unit token the dashboard summary wire hands the native client; the web resolves the glucose unit from the account instead",
  "labs.biomarker.form.unitPlaceholder":
    "an example of a free-text lab unit in an input placeholder, not a reading",
};

const GLUCOSE_UNIT_LITERAL = /mg\/dl|mmol\/l\b/i;

function flattenStrings(
  node: unknown,
  path: string,
  out: Array<[string, string]>,
): void {
  if (typeof node === "string") {
    out.push([path, node]);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      flattenStrings(value, path ? `${path}.${key}` : key, out);
    }
  }
}

describe("unit-preference display guard — locale strings", () => {
  const MESSAGES = join(process.cwd(), "messages");
  const bundles = readdirSync(MESSAGES).filter((f) => f.endsWith(".json"));

  it("reads every locale bundle", () => {
    expect(bundles.length).toBeGreaterThanOrEqual(7);
  });

  it("no locale string fixes a glucose unit outside the allowlist", () => {
    // A sentence that prints "70–180 mg/dL" shows mg/dL to a reader who
    // chose mmol/L. Band and unit go in as parameters (`glucoseBandParams`).
    const offenders: string[] = [];
    for (const file of bundles) {
      const entries: Array<[string, string]> = [];
      flattenStrings(
        JSON.parse(readFileSync(join(MESSAGES, file), "utf8")),
        "",
        entries,
      );
      for (const [key, value] of entries) {
        if (key in GLUCOSE_UNIT_LITERAL_ALLOWLIST) continue;
        if (GLUCOSE_UNIT_LITERAL.test(value)) offenders.push(`${file}: ${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every allowlisted key still exists and still names a unit", () => {
    // An entry whose string was reworded or removed is a stale exemption.
    const en: Array<[string, string]> = [];
    flattenStrings(
      JSON.parse(readFileSync(join(MESSAGES, "en.json"), "utf8")),
      "",
      en,
    );
    const byKey = new Map(en);
    const stale = Object.keys(GLUCOSE_UNIT_LITERAL_ALLOWLIST).filter(
      (key) => !GLUCOSE_UNIT_LITERAL.test(byKey.get(key) ?? ""),
    );
    expect(stale).toEqual([]);
  });
});

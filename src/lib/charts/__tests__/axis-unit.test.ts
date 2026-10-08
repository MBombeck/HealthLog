import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  stripComments,
  walkSourceFiles,
} from "@/__tests__/helpers/source-files";
import { axisTickUnitSuffix, axisUnitSuffix } from "../axis-unit";

const COMPONENTS = join(process.cwd(), "src", "components");

/**
 * Every `<XAxis … />` / `<YAxis … />` tag's `unit=` value in the tree. The tag
 * runs to its `/>`: stopping at the first `>` would end it inside an arrow
 * function prop and miss a `unit` written after one.
 */
function axisUnitProps(): Array<{ file: string; value: string }> {
  const out: Array<{ file: string; value: string }> = [];
  for (const rel of walkSourceFiles(COMPONENTS, {
    floor: 300,
    extensions: [".tsx"],
  })) {
    if (rel.includes("__tests__")) continue;
    const src = stripComments(readFileSync(join(COMPONENTS, rel), "utf8"));
    for (const tag of src.matchAll(/<[XY]Axis\b[\s\S]*?\/>/g)) {
      const unit = /\bunit=(\{[\s\S]*?\}|"[^"]*")/.exec(tag[0]);
      if (unit) out.push({ file: rel, value: unit[1] });
    }
  }
  return out;
}

describe("axis unit suffix", () => {
  it("joins the unit with a no-break space", () => {
    expect(axisUnitSuffix("bpm")).toBe(" bpm");
    expect(axisUnitSuffix("")).toBeUndefined();
    expect(axisUnitSuffix(null)).toBeUndefined();
  });

  it("finds the axis units it is meant to police", () => {
    // A matcher that finds nothing would pass the check below by default.
    expect(axisUnitProps().length).toBeGreaterThanOrEqual(6);
  });

  it("no chart axis joins a unit with a breaking space", () => {
    // Recharts wraps a tick label at a breaking space when it measures the
    // label wider than the axis, and it measures in the body font: "62 bpm"
    // broke onto two lines and its second line sat on the first x tick.
    const offenders = axisUnitProps()
      .filter(({ value }) => /["`] /.test(value))
      .map(({ file, value }) => `${file}: unit=${value}`);
    expect(offenders).toEqual([]);
  });
});

describe("axisTickUnitSuffix", () => {
  it("keeps a short unit on the ticks", () => {
    expect(axisTickUnitSuffix("bpm")).toBe(axisUnitSuffix("bpm"));
    expect(axisTickUnitSuffix("mg/dL")).toBe(axisUnitSuffix("mg/dL"));
  });
  it("keeps a word-length unit off the ticks, where it was clipped", () => {
    expect(axisTickUnitSuffix("Schritte")).toBeUndefined();
    expect(axisTickUnitSuffix("Atemzüge/min")).toBeUndefined();
    expect(axisTickUnitSuffix("mL/(kg·min)")).toBeUndefined();
  });
});

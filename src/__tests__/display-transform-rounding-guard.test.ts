/**
 * Guard for the converted-value precision class (issue #627, second half).
 *
 * Every entry in the display-transform registry declares the `decimals` its
 * unit is read at. Before v1.32.39 that number was carried all the way to the
 * render layer and read by exactly one screen out of all the ones that show a
 * converted value, so everywhere else the raw product of a kilogram and
 * 2.20462262185 reached the surface unrounded. The fix moved the rounding into
 * the conversion helpers, which means a surface gets a correctly-scaled number
 * whether or not it remembers to ask.
 *
 * This file guards the two ways that could be undone:
 *
 *   1. A PROPERTY over the whole registry — every branch, swept over a spread
 *      of raw values, must come out already at its declared grain, and a
 *      non-rescaling branch must come out byte-identical. A property test is
 *      the honest shape here: the thing being guaranteed is arithmetic, and a
 *      structural sweep for "did the surface remember to round" is exactly the
 *      per-call-site discipline this change exists to abolish.
 *   2. A STRUCTURAL freeze on the two ways to get an unrounded converted value
 *      anyway — importing the documented escape hatch, or hand-rolling
 *      `value * transform.factor + transform.offset` at a call site. Both sets
 *      are pinned to a named allowlist, so a new converted-value surface
 *      cannot quietly join them.
 */
import { join } from "node:path";

import { readSourceText, walkSourceFiles } from "./helpers/source-files";

import { describe, it, expect } from "vitest";

import {
  applyDisplayTransform,
  applyDisplayTransformDelta,
  getDisplayTransform,
  transformRescales,
  TRANSFORMED_TYPES,
} from "@/lib/measurements/display-transform";

const SRC = join(process.cwd(), "src");

/** The registry itself owns the arithmetic; it is not a call site. */
const REGISTRY = "lib/measurements/display-transform.ts";

/**
 * The one module allowed to import the unrounded escape hatch. The target
 * adapter needs the unrounded pound edge of a canonical guardrail so it can
 * round it INWARD — rounding to the nearest tenth first gives 66.1 lb for the
 * 30 kg floor, which inverts to 29.98 kg and the server rejects it.
 */
const UNROUNDED_IMPORTERS = ["lib/targets/target-unit-display.ts"];

/**
 * The surfaces allowed to read a transform's raw `factor` / `offset`. All five
 * do it for the same reason: the chart takes the multiplier as a prop, folds
 * it into its own series at the single read boundary, and formats the result
 * itself. Everything those files RENDER directly goes through the rounding
 * helpers. Adding a file here means arguing that its number never reaches a
 * screen unrounded.
 */
const RAW_SCALE_SURFACES = [
  // The dashboard's chart cards; the values the dashboard renders itself
  // convert in the tile context (see `CONVERTS_IN`).
  "components/dashboard/tiles/chart-tiles.tsx",
  // The insights trends row: a single transformed series hands its scale
  // and offset to the mini chart, which formats every value itself.
  "components/insights/trends-row.tsx",
  "app/insights/weight/page.tsx",
  "components/insights/healthkit-metric-page.tsx",
  "components/insights/device-score-tile.tsx",
];

/**
 * A surface whose rendered values convert in a sibling module: the dashboard's
 * chart cards read the preference through the tile context every dashboard
 * tile is built from.
 */
const CONVERTS_IN: Readonly<Record<string, string>> = {
  "components/dashboard/tiles/chart-tiles.tsx":
    "components/dashboard/tiles/tile-context.ts",
};

/** Matches a `factor` / `offset` read off a display transform. */
const RAW_SCALE_READ =
  /\b\w*[Tt]ransform(?:For\([^)]*\))?\??\.(factor|offset)\b/;

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 }).filter(
    (rel) =>
      // Never walk the Prisma client, and skip the suites that legitimately
      // exercise the raw arithmetic they are asserting about.
      !rel.startsWith("generated/") && !rel.includes("__tests__/"),
  );
}

function read(rel: string): string {
  return readSourceText(join(SRC, rel));
}

describe("display-transform rounding guard — the registry property", () => {
  const RAW_VALUES = [
    0, 1, 1.3, 10, 36.6, 36.66666, 37, 78.45, 83.99981845627636, 84, 95.25, 210,
    1609.344, 8046.72, -0.5, -12.3456789,
  ];

  it("sweeps a non-empty registry", () => {
    // Guards against a set that silently empties out (a green void).
    expect(TRANSFORMED_TYPES.size).toBeGreaterThan(5);
  });

  it("declares a usable decimal count on every branch", () => {
    for (const type of TRANSFORMED_TYPES) {
      for (const preference of ["metric", "imperial"] as const) {
        const { decimals } = getDisplayTransform(type, preference);
        expect(Number.isInteger(decimals)).toBe(true);
        expect(decimals).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("never returns a converted value finer than its declared decimals", () => {
    const offenders: string[] = [];
    for (const type of TRANSFORMED_TYPES) {
      for (const preference of ["metric", "imperial"] as const) {
        const transform = getDisplayTransform(type, preference);
        if (!transformRescales(transform)) continue;
        const scale = 10 ** transform.decimals;
        for (const raw of RAW_VALUES) {
          for (const [label, shown] of [
            ["absolute", applyDisplayTransform(raw, transform)],
            ["delta", applyDisplayTransformDelta(raw, transform)],
          ] as const) {
            // Re-rounding at the declared grain must be a no-op: the value
            // carries no more precision than the transform says it should.
            if (Math.round(shown * scale) / scale !== shown) {
              offenders.push(
                `${type}/${preference} ${label} ${raw} → ${shown}`,
              );
            }
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("leaves a non-rescaling branch byte-identical", () => {
    // The metric branch only relabels the symbol; the number it shows IS the
    // stored number, and a stored 78.45 kg is not conversion noise.
    const offenders: string[] = [];
    for (const type of TRANSFORMED_TYPES) {
      for (const preference of ["metric", "imperial"] as const) {
        const transform = getDisplayTransform(type, preference);
        if (transformRescales(transform)) continue;
        for (const raw of RAW_VALUES) {
          if (applyDisplayTransform(raw, transform) !== raw) {
            offenders.push(`${type}/${preference} absolute ${raw}`);
          }
          if (applyDisplayTransformDelta(raw, transform) !== raw) {
            offenders.push(`${type}/${preference} delta ${raw}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("leaves an untransformed type byte-identical", () => {
    for (const type of ["PULSE", "BLOOD_GLUCOSE", "BODY_MASS_INDEX"]) {
      const transform = getDisplayTransform(type, "imperial");
      for (const raw of RAW_VALUES) {
        expect(applyDisplayTransform(raw, transform)).toBe(raw);
        expect(applyDisplayTransformDelta(raw, transform)).toBe(raw);
      }
    }
  });
});

describe("display-transform rounding guard — the bypass freeze", () => {
  it("sweeps a non-empty source tree", () => {
    expect(sourceFiles().length).toBeGreaterThan(500);
  });

  it("confines the unrounded escape hatch to its documented importers", () => {
    const importers = sourceFiles().filter(
      (rel) =>
        rel !== REGISTRY &&
        read(rel).includes("applyDisplayTransformUnrounded"),
    );
    expect(importers.sort()).toEqual([...UNROUNDED_IMPORTERS].sort());
  });

  it("confines hand-rolled transform scaling to the chart-feeding surfaces", () => {
    const offenders = sourceFiles().filter(
      (rel) =>
        rel !== REGISTRY &&
        !UNROUNDED_IMPORTERS.includes(rel) &&
        RAW_SCALE_READ.test(read(rel)),
    );
    expect(offenders.sort()).toEqual([...RAW_SCALE_SURFACES].sort());
  });

  it("every allowlisted surface reads the raw scale to feed a chart", () => {
    // The justification for holding the raw multiplier at all: the chart
    // takes it as a prop. A file that stops passing it has no reason to be
    // reading `.factor` any more and belongs back behind the helpers.
    // The prop as it is actually passed (as a JSX attribute or as a key of
    // the props a chart builder spreads) — a bare substring would still
    // match a renamed identifier that no longer reaches any chart.
    const offenders = RAW_SCALE_SURFACES.filter(
      (rel) => !/\bvalueScale[=:]/.test(read(rel)),
    );
    expect(offenders).toEqual([]);
  });

  it("every allowlisted surface still converts its rendered values", () => {
    // The chart formats its own series; anything these files render outside
    // the chart must come back through the preference hook. Either reading of
    // it counts: a surface that paints inside a streamed page boundary takes
    // `useUnitDisplayOnceMounted()`, which is the same sugar with the
    // preference withheld from the hydration render.
    const offenders = RAW_SCALE_SURFACES.filter(
      (rel) =>
        !/\buseUnitDisplay(OnceMounted)?\(\)/.test(
          read(CONVERTS_IN[rel] ?? rel),
        ),
    );
    expect(offenders).toEqual([]);
  });
});

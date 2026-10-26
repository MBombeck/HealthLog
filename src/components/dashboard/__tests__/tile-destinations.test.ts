/**
 * Every dashboard tile whose metric has an Insights sub-page opens it.
 *
 * The body fat tile was rendered without a link while its siblings each
 * opened their page, and nothing noticed, because the href map was a
 * hand-kept list beside the render code with no check tying the two
 * together. This guard derives the tile set from the registry
 * (`TILE_CAPABLE_WIDGET_IDS`) and from the dashboard's own render code, and
 * holds every tile against the sub-page registry.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { dashboardSource } from "@/__tests__/helpers/dashboard-source";
import { STRIP_TILES } from "@/components/dashboard/tiles/strip-tiles";
import type { DashboardTileContext } from "@/components/dashboard/tiles/tile-context";

import {
  TILE_CAPABLE_WIDGET_IDS,
  type TileCapableWidgetId,
} from "@/components/dashboard/dashboard-gates";
import {
  TILE_DESTINATION,
  dashboardTileHref,
  tileWidgetId,
} from "@/components/dashboard/tile-destinations";
import { subPageSlugForType } from "@/lib/insights/sub-page-metric";
import { surfaceModule } from "@/lib/modules/surface";

const ROOT = path.resolve(__dirname, "../../../..");

/**
 * The series each tile paints. Kept here rather than in production code
 * because only this guard needs it; a tile id missing from this record
 * fails the totality test below, so a new tile cannot skip the question.
 */
const TILE_TYPES: Record<TileCapableWidgetId, readonly string[]> = {
  weight: ["WEIGHT"],
  bp: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
  pulse: ["PULSE"],
  bodyFat: ["BODY_FAT"],
  mood: ["MOOD"],
  sleep: ["SLEEP_DURATION"],
  steps: ["ACTIVITY_STEPS"],
  glucose: ["BLOOD_GLUCOSE"],
  bpInTarget: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
  vo2Max: ["VO2_MAX"],
  hrv: ["HEART_RATE_VARIABILITY", "HRV_RMSSD"],
  oxygenSaturation: ["OXYGEN_SATURATION"],
  respiratoryRate: ["RESPIRATORY_RATE"],
  wristTemperature: ["WRIST_TEMPERATURE"],
  muscleMass: ["MUSCLE_MASS"],
  totalBodyWater: ["TOTAL_BODY_WATER"],
  boneMass: ["BONE_MASS"],
  waterIntake: ["NUTRIENT_WATER"],
};

/**
 * Tiles whose series is not a `MeasurementType` with a sub-page, but which
 * still lead to a page that shows it. Each entry names its reason.
 */
const NON_MEASUREMENT_DESTINATION: Partial<
  Record<TileCapableWidgetId, { slug: string; reason: string }>
> = {
  waterIntake: {
    slug: "nutrients",
    reason:
      "fluid intake is a NutrientIntakeDay total, charted on the nutrients page",
  },
};

/**
 * Tiles that deliberately lead nowhere, with the reason. Empty today: every
 * tile has a page. An entry here must be a tile whose destination is null.
 */
const NO_DESTINATION: Partial<Record<TileCapableWidgetId, string>> = {};

/**
 * Card ids the strip tiles paint, built from the registry with a context in
 * which every series has a reading, so every tile paints its cards.
 */
function renderedTileIds(): string[] {
  const reading = { count: 3, latest: 1, avg7: 1, avg30: 1 };
  const summaries = new Proxy({} as Record<string, typeof reading>, {
    get: () => reading,
  });
  const ctx = {
    t: (key: string) => key,
    fmt: { number: (v: number) => String(v) },
    td: (_type: string, v: number | null | undefined) => v ?? null,
    tdd: (_type: string, v: number | null | undefined) => v ?? null,
    unitDisplay: { unitFor: () => "" },
    user: null,
    summaries,
    moodSummary: reading,
    hrv: { summary: reading, type: "HRV_RMSSD", labelKey: "x" },
    data: { bpInTargetPct: 50, bpInTargetPct7d: 50, bpInTargetPct30d: 50 },
    glucoseTiles: [{ bucket: "FASTING", labelKey: "x", summary: reading }],
    displayGlucoseUnit: "mg/dL",
    weightTrend: { direction: "neutral" },
    compareBaseline: "none",
    directionOf: () => "neutral",
    tileCompareDelta: () => null,
    tileStaleDays: () => null,
  } as unknown as DashboardTileContext;
  return STRIP_TILES.flatMap((tile) => {
    expect(tile.visible(ctx), tile.widget).toBe(true);
    return tile.cards(ctx).map((card) => card.id);
  });
}

describe("dashboard tile destinations", () => {
  it("reads a non-trivial tile set from the registry and the render code", () => {
    expect(TILE_CAPABLE_WIDGET_IDS.length).toBeGreaterThanOrEqual(18);
    expect(renderedTileIds().length).toBeGreaterThanOrEqual(19);
  });

  it("knows every tile the dashboard renders, and renders every known tile", () => {
    // The registry names each tile's widget; every tile-capable widget has a
    // tile, and every card a tile paints maps back to a known widget.
    expect(STRIP_TILES.map((tile) => tile.widget).sort()).toEqual(
      [...TILE_CAPABLE_WIDGET_IDS].sort(),
    );
    const rendered = renderedTileIds();
    const widgets = new Set<string>();
    for (const id of rendered) {
      const widget = tileWidgetId(id);
      expect(widget, `rendered tile "${id}" has no widget`).not.toBeNull();
      widgets.add(widget as string);
    }
    expect([...widgets].sort()).toEqual([...TILE_CAPABLE_WIDGET_IDS].sort());
  });

  it("routes the dashboard's tile links through this map and no other", () => {
    const source = dashboardSource();
    expect(source).toMatch(/dashboardTileHref\(entry\.id,/);
    expect(source).not.toMatch(/"\/insights\/[a-z-]+"/);
  });

  it("declares the series of every tile", () => {
    expect(Object.keys(TILE_TYPES).sort()).toEqual(
      [...TILE_CAPABLE_WIDGET_IDS].sort(),
    );
  });

  it.each([...TILE_CAPABLE_WIDGET_IDS])(
    "%s opens the page of the metric it shows",
    (widget) => {
      const destination = TILE_DESTINATION[widget];
      const pages = new Set(
        TILE_TYPES[widget]
          .map((type) => subPageSlugForType(type))
          .filter((slug): slug is NonNullable<typeof slug> => slug != null),
      );
      if (pages.size > 0) {
        expect(
          destination,
          `${widget} shows ${TILE_TYPES[widget].join(", ")}, which has a page, but links nowhere`,
        ).not.toBeNull();
        expect(pages.has(destination!)).toBe(true);
        return;
      }
      const nonMeasurement = NON_MEASUREMENT_DESTINATION[widget];
      if (nonMeasurement) {
        expect(destination).toBe(nonMeasurement.slug);
        expect(nonMeasurement.reason.length).toBeGreaterThan(10);
        return;
      }
      expect(destination).toBeNull();
      expect(
        NO_DESTINATION[widget],
        `${widget} has no destination and no written reason`,
      ).toBeTruthy();
    },
  );

  it("allowlists only tiles that really lead nowhere", () => {
    for (const widget of Object.keys(NO_DESTINATION) as TileCapableWidgetId[]) {
      expect(TILE_DESTINATION[widget]).toBeNull();
    }
  });

  it("links only to sub-pages that exist as routes", () => {
    const slugs = Object.values(TILE_DESTINATION).filter(
      (slug): slug is NonNullable<typeof slug> => slug !== null,
    );
    expect(slugs.length).toBeGreaterThanOrEqual(18);
    for (const slug of slugs) {
      expect(
        existsSync(path.join(ROOT, "src/app/insights", slug, "page.tsx")),
        `/insights/${slug} has no page`,
      ).toBe(true);
    }
  });

  it("never links a tile to a page owned by a different module", () => {
    for (const widget of TILE_CAPABLE_WIDGET_IDS) {
      const slug = TILE_DESTINATION[widget];
      if (slug === null) continue;
      const pageOwner = surfaceModule(`insights-page:${slug}`);
      if (pageOwner === undefined) continue;
      expect(
        surfaceModule(`widget:${widget}`),
        `${widget} links to /insights/${slug}, owned by ${pageOwner}`,
      ).toBe(pageOwner);
    }
  });

  it("resolves the rendered tile ids to their hrefs", () => {
    expect(dashboardTileHref("bodyFat", undefined)).toBe("/insights/body-fat");
    expect(dashboardTileHref("bp-sys", undefined)).toBe(
      "/insights/blood-pressure",
    );
    expect(dashboardTileHref("bp-dia", null)).toBe("/insights/blood-pressure");
    expect(dashboardTileHref("glucose-FASTING", {})).toBe(
      "/insights/blood-glucose",
    );
    expect(dashboardTileHref("not-a-tile", undefined)).toBeNull();
  });

  it("drops the link when the destination's module is switched off", () => {
    expect(dashboardTileHref("mood", { mood: false })).toBeNull();
    expect(dashboardTileHref("glucose-FASTING", { glucose: false })).toBeNull();
    expect(dashboardTileHref("waterIntake", { nutrients: false })).toBeNull();
    expect(dashboardTileHref("bodyFat", { mood: false })).toBe(
      "/insights/body-fat",
    );
  });
});

import { describe, expect, it } from "vitest";

import type { DataSummary } from "@/lib/analytics/trends";
import type { DashboardTargetBands } from "@/lib/dashboard/bands";
import {
  DEFAULT_DASHBOARD_LAYOUT,
  resolveDashboardLayout,
  serializeDashboardLayout,
} from "@/lib/dashboard-layout";
import { resolveTileAttention } from "@/lib/dashboard/tile-attention";
import { orderStripWidgets } from "@/lib/dashboard/tile-priority";

const NOW = new Date("2026-11-26T15:00:00Z");
const TZ = "Europe/Berlin";

function summary(over: Partial<DataSummary>): DataSummary {
  return {
    count: 10,
    latest: 80,
    min: 70,
    max: 90,
    mean: 80,
    median: 80,
    avg7: 80,
    avg30: 80,
    slope7: null,
    slope30: null,
    ...over,
  };
}

const bands = {
  weightRange: { greenMin: 60, greenMax: 85, orangeMin: 55, orangeMax: 90 },
  bpSysRange: { greenMin: 100, greenMax: 130, orangeMin: 90, orangeMax: 140 },
  bpDiaRange: { greenMin: 60, greenMax: 85, orangeMin: 55, orangeMax: 90 },
  pulseDisplayRange: {
    greenMin: 50,
    greenMax: 70,
    orangeMin: 45,
    orangeMax: 80,
  },
} as unknown as DashboardTargetBands;

const seen = (iso: string) => ({ lastSeenAt: iso });

describe("resolveTileAttention", () => {
  it("names a reading outside the band, a clear week and a reading today", () => {
    const attention = resolveTileAttention({
      summaries: {
        // Diastolic out of band while systolic sits inside: the pair speaks.
        BLOOD_PRESSURE_SYS: summary({ latest: 126 }),
        BLOOD_PRESSURE_DIA: summary({ latest: 92 }),
        // Seven days adding up to 7 % of the monthly mean, well fitted.
        ACTIVITY_STEPS: summary({
          latest: 7000,
          avg30: 7000,
          slope7: { slope: 70, direction: "up", confidence: 0.9 },
        }),
        // Read today in Berlin, inside its band, no clear trend.
        WEIGHT: summary({ latest: 80 }),
        // Inside, two days old, flat: nothing to say.
        BODY_FAT: summary({ latest: 20 }),
        // Out of band but three weeks old: says nothing about today.
        RESTING_HEART_RATE: summary({ latest: 90 }),
      },
      lastSeenByType: {
        BLOOD_PRESSURE_SYS: seen("2026-11-25T07:00:00Z"),
        BLOOD_PRESSURE_DIA: seen("2026-11-25T07:00:00Z"),
        ACTIVITY_STEPS: seen("2026-11-24T20:00:00Z"),
        WEIGHT: seen("2026-11-26T06:30:00Z"),
        BODY_FAT: seen("2026-11-24T06:30:00Z"),
        RESTING_HEART_RATE: seen("2026-11-05T06:30:00Z"),
      },
      bands,
      now: NOW,
      timezone: TZ,
    });
    expect(attention).toEqual({
      bp: "range",
      steps: "change",
      weight: "today",
    });
  });

  it("does not call a poorly fitted week a change", () => {
    const attention = resolveTileAttention({
      summaries: {
        ACTIVITY_STEPS: summary({
          avg30: 7000,
          slope7: { slope: 500, direction: "up", confidence: 0.3 },
        }),
      },
      lastSeenByType: { ACTIVITY_STEPS: seen("2026-11-25T20:00:00Z") },
      bands,
      now: NOW,
      timezone: TZ,
    });
    expect(attention).toEqual({});
  });
});

describe("orderStripWidgets", () => {
  it("puts pinned tiles first, then the ones with something to say", () => {
    const layout = resolveDashboardLayout({
      ...DEFAULT_DASHBOARD_LAYOUT,
      widgets: DEFAULT_DASHBOARD_LAYOUT.widgets.map((w) =>
        w.id === "sleep" ? { ...w, pinned: true } : w,
      ),
    });
    const order = orderStripWidgets(layout, { steps: "today", bp: "range" });
    expect(order.slice(0, 4)).toEqual(["sleep", "bp", "steps", "weight"]);
    // Switched-off tiles never take a place.
    expect(order).not.toContain("energyIntake");
    expect(order).not.toContain("achievements");
  });

  it("is the saved order without pins or attention", () => {
    const order = orderStripWidgets(DEFAULT_DASHBOARD_LAYOUT, undefined);
    expect(order.slice(0, 3)).toEqual(["weight", "bp", "pulse"]);
  });
});

describe("layout fields", () => {
  it("stores only a true pin and an open strip", () => {
    const stored = serializeDashboardLayout({
      ...DEFAULT_DASHBOARD_LAYOUT,
      tilesExpanded: false,
      widgets: DEFAULT_DASHBOARD_LAYOUT.widgets.map((w) => ({
        ...w,
        pinned: w.id === "weight",
      })),
    });
    expect(stored).not.toHaveProperty("tilesExpanded");
    expect(
      stored.widgets.filter((w) => "pinned" in w).map((w) => w.id),
    ).toEqual(["weight"]);
    const open = resolveDashboardLayout({ ...stored, tilesExpanded: true });
    expect(open.tilesExpanded).toBe(true);
    expect(open.widgets.find((w) => w.id === "weight")?.pinned).toBe(true);
    expect(resolveDashboardLayout(stored).tilesExpanded).toBe(false);
  });
});

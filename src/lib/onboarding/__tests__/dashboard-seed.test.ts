/**
 * v1.39 (C2) — the dashboard order the setup answers imply.
 *
 * The ordering half of Q2. Pins that every area maps only to tiles the
 * layout knows, that the seed promotes and forces visible without dropping a
 * tile, and that answers which speak to no tile seed nothing at all.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_DASHBOARD_LAYOUT,
  type DashboardWidgetId,
} from "@/lib/dashboard-layout";
import { ONBOARDING_AREA_KEYS } from "@/lib/modules/registry";

import {
  AREA_WIDGET_SEED_MAP,
  buildNeedsSeededDashboardLayout,
  promotedWidgetsFor,
} from "../dashboard-seed";

describe("AREA_WIDGET_SEED_MAP", () => {
  it("names every area, and only tiles the layout actually knows", () => {
    const known = new Set<DashboardWidgetId>(
      DEFAULT_DASHBOARD_LAYOUT.widgets.map((w) => w.id as DashboardWidgetId),
    );
    for (const area of ONBOARDING_AREA_KEYS) {
      expect(AREA_WIDGET_SEED_MAP[area]).toBeDefined();
      for (const id of AREA_WIDGET_SEED_MAP[area]) {
        expect(known.has(id), `${area} → ${id}`).toBe(true);
      }
    }
  });
});

describe("buildNeedsSeededDashboardLayout", () => {
  it("seeds nothing for answers that speak to no tile", () => {
    expect(
      buildNeedsSeededDashboardLayout({ areas: [], medication: null }),
    ).toBeNull();
    expect(
      buildNeedsSeededDashboardLayout({
        areas: ["labs", "illness", "cycle"],
        medication: "no",
      }),
    ).toBeNull();
  });

  it("promotes glucose to the top and forces it visible", () => {
    const layout = buildNeedsSeededDashboardLayout({
      areas: ["glucose"],
      medication: null,
    });
    expect(layout).not.toBeNull();
    expect(layout!.widgets.find((w) => w.id === "glucose")).toMatchObject({
      order: 0,
      visible: true,
      tileVisible: true,
    });
  });

  it("promotes every tile of a multi-area answer, and the medication tile for a schedule", () => {
    const layout = buildNeedsSeededDashboardLayout({
      areas: ["weight-body", "blood-pressure"],
      medication: "sometimes",
    });
    const promoted = new Set(
      promotedWidgetsFor({
        areas: ["weight-body", "blood-pressure"],
        medication: "sometimes",
      }),
    );
    expect(promoted).toEqual(
      new Set([
        "weight",
        "bodyFat",
        "bp",
        "bpInTarget",
        "pulse",
        "medications",
      ]),
    );
    for (const id of promoted) {
      const w = layout!.widgets.find((x) => x.id === id);
      expect(w?.visible).toBe(true);
      expect(w?.tileVisible).toBe(true);
      expect(w!.order).toBeLessThan(promoted.size);
    }
  });

  it("keeps a dense, complete widget set", () => {
    const layout = buildNeedsSeededDashboardLayout({
      areas: ["sleep"],
      medication: "no",
    });
    expect(layout!.widgets.length).toBe(
      DEFAULT_DASHBOARD_LAYOUT.widgets.length,
    );
    const orders = layout!.widgets.map((w) => w.order).sort((a, b) => a - b);
    expect(orders).toEqual(orders.map((_, i) => i));
  });
});

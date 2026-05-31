import { describe, it, expect } from "vitest";
import {
  DEFAULT_DASHBOARD_LAYOUT,
  resolveDashboardLayout,
  serializeDashboardLayout,
  DASHBOARD_WIDGET_IDS,
  DASHBOARD_IOS_ONLY_WIDGET_IDS,
  DASHBOARD_WIDGET_CATALOGUE_IDS,
  type DashboardLayout,
} from "@/lib/dashboard-layout";

/**
 * v1.4.15 Fix 5 — Dashboard layout: top tiles selectable.
 *
 * Until v1.4.14 the layout schema had a single `visible` flag per
 * widget that controlled BOTH the upper-row strip tile AND the lower-
 * row chart for the same metric. the maintainer wanted them as independent
 * toggles so a user could keep the chart on for tracking but hide
 * the tile (or vice versa). v1.4.15 introduces an optional
 * `tileVisible` field; the resolver mirrors it from `visible` for
 * legacy saved layouts so users see no behavioural change until they
 * explicitly flip the new switch.
 */

describe("resolveDashboardLayout() — tileVisible upgrade", () => {
  it("mirrors tileVisible from visible for legacy layouts (no field saved)", () => {
    const legacy = {
      version: 1,
      widgets: [
        // No tileVisible field — saved before v1.4.15.
        { id: "weight", visible: true, order: 0 },
        { id: "bp", visible: false, order: 1 },
      ],
    };
    const resolved = resolveDashboardLayout(legacy);
    const weight = resolved.widgets.find((w) => w.id === "weight");
    const bp = resolved.widgets.find((w) => w.id === "bp");
    // tileVisible mirrors visible — preserves v1.4.14 single-toggle behaviour.
    expect(weight?.tileVisible).toBe(true);
    expect(bp?.tileVisible).toBe(false);
  });

  it("respects an explicit tileVisible value when present", () => {
    const layout = {
      version: 1,
      widgets: [
        // Explicit tileVisible different from visible — user opted in
        // to v1.4.15's split control, so the resolver MUST keep both
        // values intact.
        { id: "weight", visible: true, tileVisible: false, order: 0 },
        { id: "mood", visible: false, tileVisible: true, order: 1 },
      ],
    };
    const resolved = resolveDashboardLayout(layout);
    const weight = resolved.widgets.find((w) => w.id === "weight");
    const mood = resolved.widgets.find((w) => w.id === "mood");
    expect(weight?.visible).toBe(true);
    expect(weight?.tileVisible).toBe(false);
    expect(mood?.visible).toBe(false);
    expect(mood?.tileVisible).toBe(true);
  });

  it("auto-appends new widgets with tileVisible: false", () => {
    const partial = {
      version: 1,
      // Only weight — every other widget should auto-append from defaults.
      widgets: [{ id: "weight", visible: true, tileVisible: true, order: 0 }],
    };
    const resolved = resolveDashboardLayout(partial);
    const sleep = resolved.widgets.find((w) => w.id === "sleep");
    expect(sleep).toBeDefined();
    // Auto-appended widgets default to invisible on both surfaces so a
    // user must opt in to see them after a schema upgrade.
    expect(sleep?.visible).toBe(false);
    expect(sleep?.tileVisible).toBe(false);
  });

  it("defaults the layout when raw input is null / not an object", () => {
    expect(resolveDashboardLayout(null)).toEqual(DEFAULT_DASHBOARD_LAYOUT);
    expect(resolveDashboardLayout(undefined)).toEqual(DEFAULT_DASHBOARD_LAYOUT);
  });
});

describe("serializeDashboardLayout() — tileVisible persistence", () => {
  it("persists tileVisible explicitly so a re-read keeps the user's choice", () => {
    const layout: DashboardLayout = {
      version: 1,
      widgets: [
        // User toggled tileVisible to false but kept the chart visible.
        { id: "weight", visible: true, tileVisible: false, order: 0 },
      ],
    };
    const serialized = serializeDashboardLayout(layout);
    expect(serialized.widgets[0].tileVisible).toBe(false);
    expect(serialized.widgets[0].visible).toBe(true);
  });

  it("derives tileVisible from visible when the field is missing on input", () => {
    const layout: DashboardLayout = {
      version: 1,
      widgets: [
        // Field omitted — serialize must not produce undefined; mirror.
        { id: "weight", visible: true, order: 0 },
      ],
    };
    const serialized = serializeDashboardLayout(layout);
    expect(serialized.widgets[0].tileVisible).toBe(true);
  });

  it("normalizes order to 0-based dense", () => {
    const layout: DashboardLayout = {
      version: 1,
      widgets: [
        { id: "weight", visible: true, tileVisible: true, order: 5 },
        { id: "bp", visible: true, tileVisible: true, order: 12 },
      ],
    };
    const serialized = serializeDashboardLayout(layout);
    expect(serialized.widgets.map((w) => w.order)).toEqual([0, 1]);
  });
});

/**
 * v1.4.16 Fix A5 — top-tile selector real-fix.
 *
 * the maintainer reported the toggles in Settings → Dashboard didn't filter
 * the dashboard tile-strip. Root cause: the `widgetIdEnum` Zod schema
 * in `src/app/api/dashboard/widgets/route.ts` was missing
 * `achievements` even though the default layout has it. Every PUT
 * therefore 422'd silently against the achievements widget that the
 * UI included unconditionally — the server never persisted the toggle
 * change, so reload showed the old layout.
 *
 * The default layout itself is the contract — if a widget is in
 * `DEFAULT_DASHBOARD_LAYOUT.widgets`, every consumer (settings UI,
 * dashboard renderer, API schema) must support it. This test pins
 * the contract by enumerating every widget the default layout
 * advertises, so a future addition gets caught here before the maintainer
 * finds it broken in production.
 */
describe("DEFAULT_DASHBOARD_LAYOUT contract", () => {
  it("includes the achievements widget (v1.4.15 phase-B4 + v1.4.16 A5)", () => {
    const ids = DEFAULT_DASHBOARD_LAYOUT.widgets.map((w) => w.id);
    expect(ids).toContain("achievements");
  });

  it("includes the recentWorkouts widget (v1.4.32) default-visible", () => {
    const widget = DEFAULT_DASHBOARD_LAYOUT.widgets.find(
      (w) => w.id === "recentWorkouts",
    );
    expect(widget).toBeDefined();
    expect(widget?.visible).toBe(true);
    expect(widget?.tileVisible).toBe(true);
  });

  it("does NOT advertise a retired insightsPreview widget (v1.4.27 B1)", () => {
    // v1.4.27 B1 retired the standalone dashboard preview because it
    // duplicated the much-richer `/insights` advisor surface. The
    // widget id must stay out of the default layout so a stale client
    // cannot reintroduce it via a layout PUT.
    const ids = DEFAULT_DASHBOARD_LAYOUT.widgets.map((w) => w.id);
    expect(ids).not.toContain("insightsPreview");
  });

  it("survives a round-trip through serialize → resolve unchanged", () => {
    // The API persists `serializeDashboardLayout(parsed.data)` and
    // reads back via `resolveDashboardLayout(row.dashboardWidgetsJson)`.
    // A bug in either step (missing widget, wrong order normalization)
    // would surface here. the maintainer's regression: the API schema rejected
    // the layout *before* this round-trip even started.
    const serialized = serializeDashboardLayout(DEFAULT_DASHBOARD_LAYOUT);
    const resolved = resolveDashboardLayout(serialized);
    expect(resolved.widgets.map((w) => w.id).sort()).toEqual(
      DEFAULT_DASHBOARD_LAYOUT.widgets.map((w) => w.id).sort(),
    );
  });

  it("drops widget ids the current build no longer knows about", () => {
    // v1.4.28 retired the `glp1` tile. Users who saved a layout before
    // then still have the orphan id in `dashboardWidgetsJson`; the PUT
    // route's Zod enum would reject the entire blob on the next save
    // round-trip, surfacing the "Speichern fehlgeschlagen" toast.
    // The resolver filters unknown ids on read so the GET shape is
    // current-build-safe and the next save round-trips cleanly.
    const stored = {
      version: 1,
      widgets: [
        { id: "weight", visible: true, tileVisible: true, order: 0 },
        { id: "glp1", visible: true, tileVisible: true, order: 1 },
        { id: "bp", visible: true, tileVisible: true, order: 2 },
      ],
    };
    const resolved = resolveDashboardLayout(stored);
    const ids = resolved.widgets.map((w) => w.id);
    expect(ids).not.toContain("glp1");
    expect(ids).toContain("weight");
    expect(ids).toContain("bp");
  });
});

/**
 * v1.4.16 phase B8 — comparison baseline persistence.
 *
 * The comparison toggle (Vormonat / Vorjahr) piggy-backs on the
 * existing `User.dashboardWidgetsJson` blob per research §7 Q3
 * (no Prisma migration). The resolver must default to "none"
 * for legacy layouts where the field is absent, and must round-trip
 * the value through serialize → resolve so the UI's optimistic
 * toggle persists across reloads.
 */
describe("resolveDashboardLayout() — comparisonBaseline (B8)", () => {
  it("defaults to 'none' for legacy layouts (no field saved)", () => {
    const legacy = {
      version: 1,
      widgets: [{ id: "weight", visible: true, order: 0 }],
    };
    const resolved = resolveDashboardLayout(legacy);
    expect(resolved.comparisonBaseline).toBe("none");
  });

  it("respects an explicit comparisonBaseline value when present", () => {
    const saved = {
      version: 1,
      widgets: [{ id: "weight", visible: true, order: 0 }],
      comparisonBaseline: "lastMonth" as const,
    };
    const resolved = resolveDashboardLayout(saved);
    expect(resolved.comparisonBaseline).toBe("lastMonth");
  });

  it("clamps unknown comparisonBaseline values back to 'none'", () => {
    const saved = {
      version: 1,
      widgets: [{ id: "weight", visible: true, order: 0 }],
      comparisonBaseline: "lastDecade",
    };
    const resolved = resolveDashboardLayout(saved);
    expect(resolved.comparisonBaseline).toBe("none");
  });

  it("preserves comparisonBaseline through serialize → resolve round-trip", () => {
    const layout: DashboardLayout = {
      ...DEFAULT_DASHBOARD_LAYOUT,
      comparisonBaseline: "lastYear",
    };
    const serialized = serializeDashboardLayout(layout);
    const resolved = resolveDashboardLayout(serialized);
    expect(resolved.comparisonBaseline).toBe("lastYear");
  });
});

/**
 * v1.4.18 — per-chart overlay-prefs persistence.
 *
 * the maintainer reverted v1.4.16's always-on chart overlays (gradient, baseline,
 * target-zone shading) and asked for per-chart switches that persist
 * per user. The prefs piggy-back on `User.dashboardWidgetsJson` so we
 * stay migration-free, mirroring the B8 comparisonBaseline pattern.
 *
 * Default for every chart, every flag: false (clean line is the new
 * default; overlays are user-opt-in).
 */
describe("resolveDashboardLayout() — chartOverlayPrefs (v1.4.18)", () => {
  it("defaults to an empty per-chart prefs map for legacy layouts", () => {
    const legacy = {
      version: 1,
      widgets: [{ id: "weight", visible: true, order: 0 }],
    };
    const resolved = resolveDashboardLayout(legacy);
    expect(resolved.chartOverlayPrefs).toEqual({});
  });

  it("preserves saved per-chart prefs through serialize → resolve", () => {
    const layout: DashboardLayout = {
      ...DEFAULT_DASHBOARD_LAYOUT,
      chartOverlayPrefs: {
        bp: {
          showTrendIndicator: true,
          showTrendArrow: false,
          showTargetRange: true,
          comparisonBaseline: "lastMonth",
        },
        weight: {
          showTrendIndicator: false,
          showTrendArrow: true,
          showTargetRange: false,
          comparisonBaseline: "none",
        },
        bmi: {
          showTrendIndicator: true,
          showTrendArrow: true,
          showTargetRange: true,
          comparisonBaseline: "lastYear",
        },
        bodyFat: {
          showTrendIndicator: false,
          showTrendArrow: false,
          showTargetRange: true,
          comparisonBaseline: "none",
        },
      },
    };
    const serialized = serializeDashboardLayout(layout);
    const resolved = resolveDashboardLayout(serialized);
    expect(resolved.chartOverlayPrefs).toEqual({
      bp: {
        showTrendIndicator: true,
        showTrendArrow: false,
        showTargetRange: true,
        comparisonBaseline: "lastMonth",
      },
      weight: {
        showTrendIndicator: false,
        showTrendArrow: true,
        showTargetRange: false,
        comparisonBaseline: "none",
      },
      bmi: {
        showTrendIndicator: true,
        showTrendArrow: true,
        showTargetRange: true,
        comparisonBaseline: "lastYear",
      },
      bodyFat: {
        showTrendIndicator: false,
        showTrendArrow: false,
        showTargetRange: true,
        comparisonBaseline: "none",
      },
    });
  });

  it("clamps non-boolean toggle values back to false", () => {
    const saved = {
      version: 1,
      widgets: [{ id: "bp", visible: true, order: 0 }],
      chartOverlayPrefs: {
        bp: {
          showTrendIndicator: "yes",
          showTrendArrow: 1,
          showTargetRange: null,
          comparisonBaseline: "nextWeek",
        },
      },
    };
    const resolved = resolveDashboardLayout(saved);
    expect(resolved.chartOverlayPrefs?.bp).toEqual({
      showTrendIndicator: false,
      showTrendArrow: false,
      showTargetRange: false,
      comparisonBaseline: "none",
    });
  });

  it("ignores unknown chart keys instead of leaking them through", () => {
    const saved = {
      version: 1,
      widgets: [{ id: "bp", visible: true, order: 0 }],
      chartOverlayPrefs: {
        bp: {
          showTrendIndicator: true,
          showTrendArrow: false,
          showTargetRange: false,
          comparisonBaseline: "none",
        },
        not_a_real_chart: {
          showTrendIndicator: true,
          showTrendArrow: true,
          showTargetRange: true,
          comparisonBaseline: "lastMonth",
        },
      },
    };
    const resolved = resolveDashboardLayout(saved);
    expect(Object.keys(resolved.chartOverlayPrefs ?? {})).toEqual(["bp"]);
  });
});

/**
 * v1.7.0 — full 27-id widget catalogue for the iOS cold-launch seed.
 * The catalogue is a pure superset of the server-known ids; the
 * iOS-only ids extend it without touching the writable PUT enum.
 */
describe("DASHBOARD_WIDGET_CATALOGUE_IDS — 27-id catalogue", () => {
  it("carries exactly 27 distinct ids (16 server-known + 11 iOS-only)", () => {
    expect(DASHBOARD_WIDGET_IDS).toHaveLength(16);
    expect(DASHBOARD_IOS_ONLY_WIDGET_IDS).toHaveLength(11);
    expect(DASHBOARD_WIDGET_CATALOGUE_IDS).toHaveLength(27);
    expect(new Set(DASHBOARD_WIDGET_CATALOGUE_IDS).size).toBe(27);
  });

  it("is a superset of the server-known ids in declaration order", () => {
    expect(
      DASHBOARD_WIDGET_CATALOGUE_IDS.slice(0, DASHBOARD_WIDGET_IDS.length),
    ).toEqual([...DASHBOARD_WIDGET_IDS]);
  });

  it("does not double-book a server-known id as iOS-only", () => {
    const known = new Set<string>(DASHBOARD_WIDGET_IDS);
    for (const id of DASHBOARD_IOS_ONLY_WIDGET_IDS) {
      expect(known.has(id)).toBe(false);
    }
  });

  it("carries the locked iOS-only ids verbatim", () => {
    expect([...DASHBOARD_IOS_ONLY_WIDGET_IDS]).toEqual([
      "restingHeartRate",
      "hrv",
      "walkingSpeed",
      "walkingAsymmetry",
      "walkingStepLength",
      "bmi",
      "bodyTemperature",
      "walkingDoubleSupport",
      "respiratoryRate",
      "audioExposureEnvironment",
      "audioExposureHeadphone",
    ]);
  });
});

/**
 * v1.7.0 W1 — iOS-only ids round-trip through the stored layout so the
 * native client can drop its local merge workarounds
 * (`byMergingIosOnlyDefaults` / `byRestoringIosOnlyWidgets`). The
 * resolver + serializer must RETAIN every catalogue id (27) while the
 * default layout stays the 16 web tiles, and a genuinely-unknown id
 * outside the 27 still drops.
 */
describe("resolveDashboardLayout() — iOS-only id retention (v1.7.0)", () => {
  it("retains all 11 iOS-only ids alongside the web ids on read", () => {
    const stored = {
      version: 1,
      widgets: [
        { id: "weight", visible: true, tileVisible: true, order: 0 },
        ...DASHBOARD_IOS_ONLY_WIDGET_IDS.map((id, i) => ({
          id,
          visible: true,
          tileVisible: true,
          order: 1 + i,
        })),
      ],
    };
    const resolved = resolveDashboardLayout(stored);
    const ids = resolved.widgets.map((w) => w.id);
    for (const iosId of DASHBOARD_IOS_ONLY_WIDGET_IDS) {
      expect(ids).toContain(iosId);
    }
    expect(ids).toContain("weight");
  });

  it("round-trips the full 27-id catalogue through serialize → resolve", () => {
    const layout: DashboardLayout = {
      version: 1,
      widgets: DASHBOARD_WIDGET_CATALOGUE_IDS.map((id, i) => ({
        id,
        visible: true,
        tileVisible: true,
        order: i,
      })),
    };
    const serialized = serializeDashboardLayout(layout);
    const resolved = resolveDashboardLayout(serialized);
    expect(resolved.widgets.map((w) => w.id).sort()).toEqual(
      [...DASHBOARD_WIDGET_CATALOGUE_IDS].sort(),
    );
  });

  it("still drops an id outside the 27-catalogue while keeping iOS-only ids", () => {
    const stored = {
      version: 1,
      widgets: [
        { id: "weight", visible: true, tileVisible: true, order: 0 },
        { id: "hrv", visible: true, tileVisible: true, order: 1 }, // iOS-only
        { id: "glp1", visible: true, tileVisible: true, order: 2 }, // retired
        { id: "totally-made-up", visible: true, tileVisible: true, order: 3 },
      ],
    };
    const resolved = resolveDashboardLayout(stored);
    const ids = resolved.widgets.map((w) => w.id);
    expect(ids).toContain("hrv");
    expect(ids).not.toContain("glp1");
    expect(ids).not.toContain("totally-made-up");
  });

  it("keeps the default layout at the 16 web tiles (no iOS-only seeded)", () => {
    const ids = DEFAULT_DASHBOARD_LAYOUT.widgets.map((w) => w.id);
    expect(ids).toHaveLength(16);
    for (const iosId of DASHBOARD_IOS_ONLY_WIDGET_IDS) {
      expect(ids).not.toContain(iosId);
    }
  });

  it("does NOT auto-append iOS-only ids when a web-only layout is read", () => {
    // A web account that saved only `weight` must auto-upgrade to the 16
    // web defaults — never to the 27 catalogue. iOS-only ids appear only
    // once a native client has explicitly sent them.
    const partial = {
      version: 1,
      widgets: [{ id: "weight", visible: true, tileVisible: true, order: 0 }],
    };
    const resolved = resolveDashboardLayout(partial);
    const ids = resolved.widgets.map((w) => w.id);
    expect(ids).toHaveLength(16);
    for (const iosId of DASHBOARD_IOS_ONLY_WIDGET_IDS) {
      expect(ids).not.toContain(iosId);
    }
  });
});

import { describe, it, expect } from "vitest";
import {
  DEFAULT_DASHBOARD_LAYOUT,
  resolveDashboardLayout,
  serializeDashboardLayout,
  DASHBOARD_WIDGET_IDS,
  DASHBOARD_IOS_ONLY_WIDGET_IDS,
  DASHBOARD_WIDGET_CATALOGUE_IDS,
  IOS_PIN_ONLY_WIDGET_IDS,
  DEFAULT_HERO_RING_ORDER,
  resolveHeroRingOrder,
  LAYOUT_FIELD_MERGE_DISPOSITION,
  PRESERVED_LAYOUT_FIELDS,
  layoutNeedsPreserveRead,
  mergePreservedLayoutFields,
  type DashboardLayout,
} from "@/lib/dashboard-layout";
import { PRIORITY_ITEM_KINDS } from "@/lib/daily/priority-item";

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
 * The maintainer reported the toggles in Settings → Dashboard didn't filter
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

  it("ships the vo2Max strip tile default-on, chart row default-off (v1.18.9)", () => {
    // VO2max is ingested from Withings / Apple Health / Fitbit / Oura but
    // the tile used to be opt-in, so accounts that already synced a sample
    // saw nothing on the dashboard. The strip tile is now on by default
    // (it still self-gates on having a VO2_MAX sample in page.tsx), while
    // the chart row stays off because VO2max charts live on the
    // /insights/cardio-fitness sub-page.
    const widget = DEFAULT_DASHBOARD_LAYOUT.widgets.find(
      (w) => w.id === "vo2Max",
    );
    expect(widget).toBeDefined();
    expect(widget?.tileVisible).toBe(true);
    expect(widget?.visible).toBe(false);
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
 * The maintainer reverted v1.4.16's always-on chart overlays (gradient, baseline,
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
 * The legacy opt-in dashboard hero was retired; its `heroVisible` flag is
 * gone from the layout type, defaults, resolver, and serializer. A stored
 * blob that still carries the field must resolve without throwing and drop
 * it silently (the resolver is a whitelist constructor, so an unknown key
 * is ignored on read and never re-persisted).
 */
describe("resolveDashboardLayout() — retired heroVisible field", () => {
  it("drops a stored heroVisible without throwing", () => {
    const saved = {
      version: 1,
      widgets: [{ id: "weight", visible: true, order: 0 }],
      heroVisible: true,
    };
    const resolved = resolveDashboardLayout(saved) as unknown as Record<
      string,
      unknown
    >;
    expect(resolved).not.toHaveProperty("heroVisible");
  });

  it("does not carry heroVisible on DEFAULT_DASHBOARD_LAYOUT", () => {
    expect(DEFAULT_DASHBOARD_LAYOUT).not.toHaveProperty("heroVisible");
  });

  it("does not re-emit heroVisible on serialize", () => {
    const saved = {
      version: 1,
      widgets: [{ id: "weight", visible: true, order: 0 }],
      heroVisible: true,
    };
    const serialized = serializeDashboardLayout(
      resolveDashboardLayout(saved),
    ) as unknown as Record<string, unknown>;
    expect(serialized).not.toHaveProperty("heroVisible");
  });
});

/**
 * v1.7.0 — full 27-id widget catalogue for the iOS cold-launch seed.
 * The catalogue is a pure superset of the server-known ids; the
 * iOS-only ids extend it without touching the writable PUT enum.
 */
describe("DASHBOARD_WIDGET_CATALOGUE_IDS — 27-id catalogue", () => {
  it("carries exactly 42 distinct ids (29 server-known + 13 iOS-only)", () => {
    // v1.11.2 B5 — the 8 v1.10 additive metrics became web-writable, so
    // the server-known set grew 16 → 24 and the catalogue 27 → 35.
    // v1.18.2 — the Vorsorge summary widget added one server-known id
    // (24 → 25), so the catalogue grew 35 → 36.
    // v1.28.52 — HRV + respiratory rate graduated from the iOS-only set to
    // web-writable (iOS-only 11 → 9), and muscle mass is a brand-new
    // writable id, so the server-known set grew 25 → 28 and the catalogue
    // 36 → 37.
    // v1.29 — the nutrients-store-backed fluid-intake strip tile
    // (`waterIntake`) added one server-known id, so the catalogue grew
    // 37 → 38.
    // The four clinical signals the native client pins (grip strength, pain
    // NRS, waist circumference, waist-to-height) joined the iOS-only set
    // (9 → 13), so the catalogue grew 38 → 42. Before they were catalogued
    // the widgets PUT dropped them as unknown ids and every native layout
    // save lost the user's placement of those tiles.
    expect(DASHBOARD_WIDGET_IDS).toHaveLength(29);
    expect(DASHBOARD_IOS_ONLY_WIDGET_IDS).toHaveLength(13);
    expect(DASHBOARD_WIDGET_CATALOGUE_IDS).toHaveLength(42);
    expect(new Set(DASHBOARD_WIDGET_CATALOGUE_IDS).size).toBe(42);
  });

  it("catalogues the four clinical signals the native client pins", () => {
    // Regression guard: these four reached the widgets PUT as unknown ids,
    // were filtered out before Zod, and vanished from the persisted layout
    // — a silent loss of the user's tile placement on every save.
    for (const id of [
      "gripStrength",
      "painNRS",
      "waistCircumference",
      "waistToHeight",
    ]) {
      expect(DASHBOARD_WIDGET_CATALOGUE_IDS).toContain(id);
    }
  });

  it("keeps the four clinical signals out of the web-writable set", () => {
    // The web dashboard has no render path for them — their charts live on
    // the /insights sub-pages — so a web Settings toggle would do nothing.
    for (const id of [
      "gripStrength",
      "painNRS",
      "waistCircumference",
      "waistToHeight",
    ]) {
      expect(DASHBOARD_WIDGET_IDS).not.toContain(id);
    }
  });

  it("ships the sleep / steps / glucose strip tiles default-on (v1.20.0)", () => {
    // These modules are on by default and their tiles self-gate on having
    // data in page.tsx, so accounts that sync sleep / step / glucose data
    // discover the tiles on / without hunting through Settings. The chart
    // rows stay off because those charts live on the /insights sub-pages.
    for (const id of ["sleep", "steps", "glucose"]) {
      const widget = DEFAULT_DASHBOARD_LAYOUT.widgets.find((w) => w.id === id);
      expect(widget).toBeDefined();
      expect(widget?.tileVisible).toBe(true);
      expect(widget?.visible).toBe(false);
    }
  });

  it("registers the Vorsorge widget chart-row default-on (v1.20.0)", () => {
    // v1.18.2 — Vorsorge is a first-class chart-row widget (no strip tile).
    // v1.20.0 flipped it default-visible so preventive-care reminders
    // surface on /; it self-gates and renders nothing without due reminders.
    expect(DASHBOARD_WIDGET_IDS).toContain("vorsorge");
    const entry = DEFAULT_DASHBOARD_LAYOUT.widgets.find(
      (w) => w.id === "vorsorge",
    );
    expect(entry).toBeDefined();
    expect(entry?.visible).toBe(true);
    expect(entry?.tileVisible).toBe(false);
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
    // v1.28.52 — `hrv` + `respiratoryRate` left this set for the writable
    // DASHBOARD_WIDGET_IDS (they gained a web strip tile).
    // The four clinical signals joined so the widgets PUT stops dropping
    // them as unknown ids; `painNRS` is spelled as the native client sends
    // it, which differs in case from the `painNrs` chart-overlay slot.
    expect([...DASHBOARD_IOS_ONLY_WIDGET_IDS]).toEqual([
      "restingHeartRate",
      "walkingSpeed",
      "walkingAsymmetry",
      "walkingStepLength",
      "bmi",
      "bodyTemperature",
      "walkingDoubleSupport",
      "audioExposureEnvironment",
      "audioExposureHeadphone",
      "gripStrength",
      "painNRS",
      "waistCircumference",
      "waistToHeight",
    ]);
  });
});

/**
 * v1.28.52 — vitals + body-composition strip tiles. Seven metrics
 * HealthLog already collects (HRV, SpO2, respiratory rate, wrist
 * temperature, muscle mass, total body water, bone mass) gain a
 * dashboard strip tile. Each must be a WRITABLE widget id (so the PUT
 * enum + Settings toggle accept it) with a default layout row that turns
 * the strip tile on and keeps the chart row off (the tile self-gates on
 * data in page.tsx; the chart lives on the /insights sub-page).
 */
describe("v1.28.52 — vitals + body-composition strip tiles", () => {
  const NEW_TILE_IDS = [
    "hrv",
    "oxygenSaturation",
    "respiratoryRate",
    "wristTemperature",
    "muscleMass",
    "totalBodyWater",
    "boneMass",
  ] as const;

  it("registers every new tile id as a writable widget (Settings enum + PUT accept it)", () => {
    const writable = new Set<string>(DASHBOARD_WIDGET_IDS);
    for (const id of NEW_TILE_IDS) {
      expect(writable.has(id)).toBe(true);
    }
  });

  it("carries a default layout row for every new tile: strip tile on, chart row off", () => {
    for (const id of NEW_TILE_IDS) {
      const widget = DEFAULT_DASHBOARD_LAYOUT.widgets.find((w) => w.id === id);
      expect(widget, `default row for ${id}`).toBeDefined();
      // Strip tile on so accounts that sync the metric discover it on /;
      // it self-gates on `count > 0` in page.tsx.
      expect(widget?.tileVisible, `${id} tileVisible`).toBe(true);
      // Chart row off — those charts live on the /insights sub-pages.
      expect(widget?.visible, `${id} visible`).toBe(false);
    }
  });

  it("keeps the promoted ids out of the iOS-only + pin-only sets (no double-book)", () => {
    const iosOnly = new Set<string>(DASHBOARD_IOS_ONLY_WIDGET_IDS);
    const pinOnly = new Set<string>(IOS_PIN_ONLY_WIDGET_IDS);
    for (const id of NEW_TILE_IDS) {
      expect(iosOnly.has(id), `${id} not iOS-only`).toBe(false);
      expect(pinOnly.has(id), `${id} not pin-only`).toBe(false);
    }
  });

  it("round-trips every new tile id through serialize → resolve", () => {
    const resolved = resolveDashboardLayout(
      serializeDashboardLayout(DEFAULT_DASHBOARD_LAYOUT),
    );
    const ids = new Set(resolved.widgets.map((w) => w.id));
    for (const id of NEW_TILE_IDS) {
      expect(ids.has(id), `${id} survives round-trip`).toBe(true);
    }
  });
});

/**
 * v1.11.2 HIGH-1 — the 8 B5 metrics are WRITABLE (members of
 * `DASHBOARD_WIDGET_IDS`, so the widgets PUT enum — derived from the
 * catalogue — accepts them, which the iOS Home-pin request requires) but
 * have NO web render path. `IOS_PIN_ONLY_WIDGET_IDS` names exactly that
 * set so the web Settings list can filter them out (asserted in
 * `dashboard-layout-section.test.tsx`).
 */
describe("IOS_PIN_ONLY_WIDGET_IDS — writable but not web-rendered", () => {
  it("is the 7 pin-only ids verbatim", () => {
    // v1.28.52 — `wristTemperature` graduated to a web-rendered strip tile,
    // so it is no longer pin-only (the Settings list now offers its toggle).
    expect([...IOS_PIN_ONLY_WIDGET_IDS]).toEqual([
      "cardioRecovery",
      "sixMinuteWalk",
      "stairAscentSpeed",
      "stairDescentSpeed",
      "breathingDisturbances",
      "falls",
      "walkingSteadiness",
    ]);
  });

  it("every pin-only id is WRITABLE (in DASHBOARD_WIDGET_IDS so the PUT enum accepts it)", () => {
    const writable = new Set<string>(DASHBOARD_WIDGET_IDS);
    for (const id of IOS_PIN_ONLY_WIDGET_IDS) {
      expect(writable.has(id)).toBe(true);
    }
  });

  it("every pin-only id is in the catalogue the widgets PUT Zod enum derives from", () => {
    const catalogue = new Set<string>(DASHBOARD_WIDGET_CATALOGUE_IDS);
    for (const id of IOS_PIN_ONLY_WIDGET_IDS) {
      expect(catalogue.has(id)).toBe(true);
    }
  });

  it("does not overlap the iOS-only (non-writable) catalogue ids", () => {
    const iosOnly = new Set<string>(DASHBOARD_IOS_ONLY_WIDGET_IDS);
    for (const id of IOS_PIN_ONLY_WIDGET_IDS) {
      expect(iosOnly.has(id)).toBe(false);
    }
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
        { id: "hrv", visible: true, tileVisible: true, order: 1 }, // catalogue id
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

  it("keeps the default layout at the 29 web tiles (no iOS-only seeded)", () => {
    const ids = DEFAULT_DASHBOARD_LAYOUT.widgets.map((w) => w.id);
    expect(ids).toHaveLength(29);
    for (const iosId of DASHBOARD_IOS_ONLY_WIDGET_IDS) {
      expect(ids).not.toContain(iosId);
    }
  });

  it("does NOT auto-append iOS-only ids when a web-only layout is read", () => {
    // A web account that saved only `weight` must auto-upgrade to the 29
    // web defaults — never to the 38 catalogue. iOS-only ids appear only
    // once a native client has explicitly sent them.
    const partial = {
      version: 1,
      widgets: [{ id: "weight", visible: true, tileVisible: true, order: 0 }],
    };
    const resolved = resolveDashboardLayout(partial);
    const ids = resolved.widgets.map((w) => w.id);
    expect(ids).toHaveLength(29);
    for (const iosId of DASHBOARD_IOS_ONLY_WIDGET_IDS) {
      expect(ids).not.toContain(iosId);
    }
  });
});

/**
 * v1.27.7 — hero score rings (`selectedScoreRings`). Closed id set, max
 * three, dedupe + unknown-drop on read, default single MED_COMPLIANCE
 * ring for legacy blobs, explicit empty array respected.
 */
describe("resolveDashboardLayout() — selectedScoreRings", () => {
  const base = {
    version: 1,
    widgets: [{ id: "weight", visible: true, tileVisible: true, order: 0 }],
  };

  it("defaults a legacy blob (field missing) to the single MED_COMPLIANCE ring", () => {
    const resolved = resolveDashboardLayout(base);
    expect(resolved.selectedScoreRings).toEqual(["MED_COMPLIANCE"]);
  });

  it("defaults a null / non-array field to MED_COMPLIANCE", () => {
    for (const bad of [null, "READINESS", 3, { READINESS: true }]) {
      const resolved = resolveDashboardLayout({
        ...base,
        selectedScoreRings: bad,
      });
      expect(resolved.selectedScoreRings).toEqual(["MED_COMPLIANCE"]);
    }
  });

  it("respects an explicitly-saved empty array (user chose no rings)", () => {
    const resolved = resolveDashboardLayout({
      ...base,
      selectedScoreRings: [],
    });
    expect(resolved.selectedScoreRings).toEqual([]);
  });

  it("drops unknown ids and dedupes, preserving selection order", () => {
    const resolved = resolveDashboardLayout({
      ...base,
      selectedScoreRings: [
        "SLEEP_SCORE",
        "STRESS_SCORE", // not a ring id — drops
        "READINESS",
        "SLEEP_SCORE", // duplicate — collapses
      ],
    });
    expect(resolved.selectedScoreRings).toEqual(["SLEEP_SCORE", "READINESS"]);
  });

  it("clamps the selection to three rings (first three win)", () => {
    const resolved = resolveDashboardLayout({
      ...base,
      selectedScoreRings: [
        "READINESS",
        "RECOVERY_SCORE",
        "SLEEP_SCORE",
        "MED_COMPLIANCE",
      ],
    });
    expect(resolved.selectedScoreRings).toEqual([
      "READINESS",
      "RECOVERY_SCORE",
      "SLEEP_SCORE",
    ]);
  });

  it("serializeDashboardLayout persists the coerced selection explicitly", () => {
    const serialized = serializeDashboardLayout({
      ...DEFAULT_DASHBOARD_LAYOUT,
      selectedScoreRings: [
        "MED_COMPLIANCE",
        "MED_COMPLIANCE",
        "READINESS",
        "RECOVERY_SCORE",
        "SLEEP_SCORE",
      ],
    } as DashboardLayout);
    expect(serialized.selectedScoreRings).toEqual([
      "MED_COMPLIANCE",
      "READINESS",
      "RECOVERY_SCORE",
    ]);
  });

  it("the default layout carries the MED_COMPLIANCE ring", () => {
    expect(DEFAULT_DASHBOARD_LAYOUT.selectedScoreRings).toEqual([
      "MED_COMPLIANCE",
    ]);
  });
});
describe("resolveDashboardLayout() — enabledHeroItemKinds", () => {
  const legacy = {
    version: 1,
    widgets: [{ id: "weight", visible: true, tileVisible: true, order: 0 }],
  };

  it("enables every current kind for legacy layouts", () => {
    expect(resolveDashboardLayout(legacy).enabledHeroItemKinds).toEqual([
      ...PRIORITY_ITEM_KINDS,
    ]);
  });

  it("preserves an explicit all-off choice through resolve and serialize", () => {
    const resolved = resolveDashboardLayout({
      ...legacy,
      enabledHeroItemKinds: [],
    });
    expect(resolved.enabledHeroItemKinds).toEqual([]);

    const serialized = serializeDashboardLayout(resolved);
    expect(serialized.enabledHeroItemKinds).toEqual([]);
    expect(resolveDashboardLayout(serialized).enabledHeroItemKinds).toEqual([]);
  });

  it("drops unknown values, deduplicates, and restores catalogue order", () => {
    const resolved = resolveDashboardLayout({
      ...legacy,
      enabledHeroItemKinds: [
        "sync_issue",
        "future_item",
        "sync_issue",
        "dose_window",
      ],
    });
    expect(resolved.enabledHeroItemKinds).toEqual([
      "dose_window",
      "sync_issue",
    ]);
  });

  it("omits the all-enabled default from storage", () => {
    const serialized = serializeDashboardLayout({
      ...DEFAULT_DASHBOARD_LAYOUT,
      enabledHeroItemKinds: [...PRIORITY_ITEM_KINDS].reverse(),
    });
    expect(
      Object.prototype.hasOwnProperty.call(serialized, "enabledHeroItemKinds"),
    ).toBe(false);
    expect(resolveDashboardLayout(serialized).enabledHeroItemKinds).toEqual([
      ...PRIORITY_ITEM_KINDS,
    ]);
  });

  it("keeps a non-full subset in canonical catalogue order", () => {
    const serialized = serializeDashboardLayout({
      ...DEFAULT_DASHBOARD_LAYOUT,
      enabledHeroItemKinds: ["sync_issue", "dose_window"],
    });
    expect(serialized.enabledHeroItemKinds).toEqual([
      "dose_window",
      "sync_issue",
    ]);
  });

  it("the default layout enables every current kind", () => {
    expect(DEFAULT_DASHBOARD_LAYOUT.enabledHeroItemKinds).toEqual([
      ...PRIORITY_ITEM_KINDS,
    ]);
  });
});

/**
 * v1.27.27 — hero ring ORDER (`heroRingOrder`). The health-score ring is a
 * first-class, always-present, reorderable member of the hero row that
 * leads by default. The order rides the layout blob (no migration) and the
 * resolver reconciles it against the selected set on every read/serialize.
 */
describe("resolveHeroRingOrder()", () => {
  it("defaults a missing / malformed order to health-score-first", () => {
    for (const bad of [undefined, null, "READINESS", 3, { a: 1 }]) {
      expect(
        resolveHeroRingOrder(bad, ["READINESS", "MED_COMPLIANCE"]),
      ).toEqual(["HEALTH_SCORE", "READINESS", "MED_COMPLIANCE"]);
    }
  });

  it("honours a stored order that moves the health-score ring off the lead", () => {
    expect(
      resolveHeroRingOrder(
        ["READINESS", "HEALTH_SCORE", "MED_COMPLIANCE"],
        ["READINESS", "MED_COMPLIANCE"],
      ),
    ).toEqual(["READINESS", "HEALTH_SCORE", "MED_COMPLIANCE"]);
  });

  it("drops an ordered id whose ring is no longer selected", () => {
    expect(
      resolveHeroRingOrder(
        ["READINESS", "HEALTH_SCORE", "SLEEP_SCORE"],
        ["READINESS"], // SLEEP_SCORE deselected
      ),
    ).toEqual(["READINESS", "HEALTH_SCORE"]);
  });

  it("appends a newly-selected ring the stored order didn't place", () => {
    expect(
      resolveHeroRingOrder(
        ["HEALTH_SCORE", "READINESS"],
        ["READINESS", "MED_COMPLIANCE"], // MED_COMPLIANCE freshly added
      ),
    ).toEqual(["HEALTH_SCORE", "READINESS", "MED_COMPLIANCE"]);
  });

  it("drops unknown ids and collapses duplicates, always keeping the health-score ring", () => {
    expect(
      resolveHeroRingOrder(
        ["READINESS", "BOGUS", "READINESS", "HEALTH_SCORE"],
        ["READINESS"],
      ),
    ).toEqual(["READINESS", "HEALTH_SCORE"]);
  });

  it("appends the health-score ring when a corrupt order omits it entirely", () => {
    expect(resolveHeroRingOrder(["READINESS"], ["READINESS"])).toEqual([
      "READINESS",
      "HEALTH_SCORE",
    ]);
  });
});

describe("resolveDashboardLayout() / serialize — heroRingOrder", () => {
  const base = {
    version: 1,
    widgets: [{ id: "weight", visible: true, tileVisible: true, order: 0 }],
  };

  it("a legacy blob (field missing) resolves to health-score-first over the selected rings", () => {
    const resolved = resolveDashboardLayout({
      ...base,
      selectedScoreRings: ["READINESS", "SLEEP_SCORE"],
    });
    expect(resolved.heroRingOrder).toEqual([
      "HEALTH_SCORE",
      "READINESS",
      "SLEEP_SCORE",
    ]);
  });

  it("reconciles a stored order against the selected set on read", () => {
    const resolved = resolveDashboardLayout({
      ...base,
      selectedScoreRings: ["READINESS", "MED_COMPLIANCE"],
      heroRingOrder: ["MED_COMPLIANCE", "HEALTH_SCORE", "READINESS"],
    });
    expect(resolved.heroRingOrder).toEqual([
      "MED_COMPLIANCE",
      "HEALTH_SCORE",
      "READINESS",
    ]);
  });

  it("serialize persists a reconciled order and round-trips", () => {
    const serialized = serializeDashboardLayout({
      ...DEFAULT_DASHBOARD_LAYOUT,
      selectedScoreRings: ["READINESS", "MED_COMPLIANCE"],
      heroRingOrder: ["READINESS", "HEALTH_SCORE", "MED_COMPLIANCE"],
    } as DashboardLayout);
    expect(serialized.heroRingOrder).toEqual([
      "READINESS",
      "HEALTH_SCORE",
      "MED_COMPLIANCE",
    ]);
    expect(resolveDashboardLayout(serialized).heroRingOrder).toEqual([
      "READINESS",
      "HEALTH_SCORE",
      "MED_COMPLIANCE",
    ]);
  });

  it("the default layout leads with the health-score ring", () => {
    expect(DEFAULT_DASHBOARD_LAYOUT.heroRingOrder).toEqual(
      DEFAULT_HERO_RING_ORDER,
    );
    expect(DEFAULT_HERO_RING_ORDER[0]).toBe("HEALTH_SCORE");
  });
});

/**
 * Preserve-when-absent contract for the widgets PUT.
 *
 * `comparisonBaseline` was a top-level layout field that the merge forgot.
 * Because `serializeDashboardLayout` clamps a missing baseline to `"none"`,
 * every layout save from a client that doesn't send the field — the native
 * client documents it as web-only and never sends it — silently reset the
 * comparison baseline the user had picked on the web. No error, no audit row.
 *
 * The fix is not "remember to add the field to the merge". It is a
 * disposition map the type system forces to cover every field of
 * `DashboardLayout`, from which the preserve set is derived. These tests pin
 * the behaviour that map buys.
 */
describe("layout field merge disposition", () => {
  /**
   * A layout with EVERY top-level field populated. Typed as
   * `Required<DashboardLayout>` so adding a field to the interface without
   * adding it here is a type error too — the runtime assertion below then
   * proves the disposition map covers it.
   */
  const fullyPopulatedLayout: Required<DashboardLayout> = {
    version: 1,
    widgets: [{ id: "weight", visible: true, tileVisible: true, order: 0 }],
    comparisonBaseline: "lastYear",
    chartOverlayPrefs: {
      weight: {
        showTrendIndicator: true,
        showTrendArrow: false,
        showTargetRange: false,
        comparisonBaseline: "none",
      },
    },
    selectedScoreRings: ["MED_COMPLIANCE"],
    heroRingOrder: ["HEALTH_SCORE", "MED_COMPLIANCE"],
    enabledHeroItemKinds: [...PRIORITY_ITEM_KINDS],
    hero: "reminders",
    todayCardVisible: false,
  };

  it("assigns a disposition to every top-level layout field", () => {
    // The guard that makes the next field impossible to forget. Adding a
    // field to `DashboardLayout` without a disposition fails typecheck at
    // the `satisfies Record<keyof DashboardLayout, …>`; this asserts the
    // same coverage at runtime so the failure is loud in the suite too.
    expect(Object.keys(LAYOUT_FIELD_MERGE_DISPOSITION).sort()).toEqual(
      Object.keys(fullyPopulatedLayout).sort(),
    );
  });

  it("only ever assigns a known disposition", () => {
    for (const disposition of Object.values(LAYOUT_FIELD_MERGE_DISPOSITION)) {
      expect(["replace", "preserve"]).toContain(disposition);
    }
  });

  it("preserves every client-owned field", () => {
    expect([...PRESERVED_LAYOUT_FIELDS].sort()).toEqual([
      "chartOverlayPrefs",
      "comparisonBaseline",
      "enabledHeroItemKinds",
      "hero",
      "heroRingOrder",
      "selectedScoreRings",
      "todayCardVisible",
      "widgets",
    ]);
  });

  it("replaces only the field every request must state", () => {
    // `version` is the sole `"replace"` field left once `widgets` joined
    // the preserve set — a PUT that omits it is rejected by Zod, so there
    // is never a stored value to fall back to.
    expect(LAYOUT_FIELD_MERGE_DISPOSITION.version).toBe("replace");
  });

  it("skips the stored-layout read when the client sent every preserved field", () => {
    expect(layoutNeedsPreserveRead(fullyPopulatedLayout)).toBe(false);
  });

  it("requires the stored-layout read when any preserved field is absent", () => {
    for (const field of PRESERVED_LAYOUT_FIELDS) {
      const incoming: Partial<DashboardLayout> = { ...fullyPopulatedLayout };
      delete incoming[field];
      expect(layoutNeedsPreserveRead(incoming)).toBe(true);
    }
  });

  it("carries an omitted comparisonBaseline forward from the stored layout", () => {
    // A widgets-only save, which is exactly what the native client sends.
    const incoming: Partial<DashboardLayout> = {
      version: 1,
      widgets: fullyPopulatedLayout.widgets,
    };
    const merged = mergePreservedLayoutFields(incoming, fullyPopulatedLayout);
    expect(merged.comparisonBaseline).toBe("lastYear");
  });

  it("carries every omitted preserved field forward, one field at a time", () => {
    for (const field of PRESERVED_LAYOUT_FIELDS) {
      const incoming: Partial<DashboardLayout> = { ...fullyPopulatedLayout };
      delete incoming[field];
      const merged = mergePreservedLayoutFields(incoming, fullyPopulatedLayout);
      expect(merged[field]).toEqual(fullyPopulatedLayout[field]);
    }
  });

  it("never overwrites a preserved field the client did send", () => {
    const stored: DashboardLayout = {
      ...fullyPopulatedLayout,
      comparisonBaseline: "lastMonth",
      selectedScoreRings: ["MED_COMPLIANCE"],
    };
    const incoming: Partial<DashboardLayout> = {
      version: 1,
      widgets: fullyPopulatedLayout.widgets,
      comparisonBaseline: "none",
      chartOverlayPrefs: fullyPopulatedLayout.chartOverlayPrefs,
      selectedScoreRings: [],
      heroRingOrder: fullyPopulatedLayout.heroRingOrder,
      enabledHeroItemKinds: [],
    };
    const merged = mergePreservedLayoutFields(incoming, stored);
    // An explicit "none" is a real choice — clearing must survive the merge.
    expect(merged.comparisonBaseline).toBe("none");
    expect(merged.selectedScoreRings).toEqual([]);
    expect(merged.enabledHeroItemKinds).toEqual([]);
  });

  it("leaves the replace-fields untouched by the merge", () => {
    const stored: DashboardLayout = {
      ...fullyPopulatedLayout,
      widgets: [{ id: "bp", visible: false, tileVisible: false, order: 0 }],
    };
    const incoming: Partial<DashboardLayout> = {
      version: 1,
      widgets: fullyPopulatedLayout.widgets,
    };
    const merged = mergePreservedLayoutFields(incoming, stored);
    expect(merged.widgets).toEqual(fullyPopulatedLayout.widgets);
  });
});

/**
 * Configurable hero primary content. The `hero` field chooses what the
 * dashboard hero card leads with: the health-score read ("score", the
 * long-standing default) or the Today-highlight rail promoted into the
 * hero slot ("reminders"). Closed two-value enum, preserve-when-absent
 * like the other layout preferences, unknown values dropped on read.
 */
describe("resolveDashboardLayout() — hero primary content", () => {
  const baseWidgets: DashboardLayout["widgets"] = [
    { id: "weight", visible: true, tileVisible: true, order: 0 },
  ];

  it("defaults to 'score' for legacy layouts (no field saved)", () => {
    const layout = resolveDashboardLayout({ version: 1, widgets: baseWidgets });
    expect(layout.hero).toBe("score");
  });

  it("defaults to 'score' on the default layout", () => {
    expect(DEFAULT_DASHBOARD_LAYOUT.hero).toBe("score");
    expect(resolveDashboardLayout(null).hero).toBe("score");
  });

  it("respects an explicit 'reminders' choice", () => {
    const layout = resolveDashboardLayout({
      version: 1,
      widgets: baseWidgets,
      hero: "reminders",
    });
    expect(layout.hero).toBe("reminders");
  });

  it("drops unknown hero values back to 'score'", () => {
    for (const garbage of ["banner", 7, null, {}, ["reminders"]]) {
      const layout = resolveDashboardLayout({
        version: 1,
        widgets: baseWidgets,
        hero: garbage,
      });
      expect(layout.hero).toBe("score");
    }
  });

  it("omits the default 'score' from serialization", () => {
    const serialized = serializeDashboardLayout({
      version: 1,
      widgets: baseWidgets,
      hero: "score",
    });
    expect("hero" in serialized).toBe(false);
  });

  it("persists 'reminders' through serialize → resolve round-trip", () => {
    const serialized = serializeDashboardLayout({
      version: 1,
      widgets: baseWidgets,
      hero: "reminders",
    });
    expect(serialized.hero).toBe("reminders");
    expect(resolveDashboardLayout(serialized).hero).toBe("reminders");
  });
});

describe("todayCardVisible — the dashboard top card switch", () => {
  const base = {
    version: 1,
    widgets: [{ id: "weight", visible: true, order: 0 }],
  };

  it("shows the top card by default", () => {
    expect(DEFAULT_DASHBOARD_LAYOUT.todayCardVisible).toBe(true);
    expect(resolveDashboardLayout(base).todayCardVisible).toBe(true);
    expect(resolveDashboardLayout(null).todayCardVisible).toBe(true);
  });

  it("hides it only on an explicit false", () => {
    expect(
      resolveDashboardLayout({ ...base, todayCardVisible: false })
        .todayCardVisible,
    ).toBe(false);
    for (const value of [true, "false", 0, null]) {
      expect(
        resolveDashboardLayout({ ...base, todayCardVisible: value })
          .todayCardVisible,
      ).toBe(true);
    }
  });

  it("is not driven by the retired heroVisible flag", () => {
    expect(
      resolveDashboardLayout({ ...base, heroVisible: false }).todayCardVisible,
    ).toBe(true);
  });

  it("stores false and omits the default", () => {
    const hidden = serializeDashboardLayout(
      resolveDashboardLayout({ ...base, todayCardVisible: false }),
    );
    expect(hidden.todayCardVisible).toBe(false);
    const shown = serializeDashboardLayout(resolveDashboardLayout(base));
    expect(shown).not.toHaveProperty("todayCardVisible");
  });

  it("round-trips through serialize and resolve", () => {
    const stored = serializeDashboardLayout({
      ...resolveDashboardLayout(base),
      todayCardVisible: false,
    });
    expect(
      resolveDashboardLayout(JSON.parse(JSON.stringify(stored)))
        .todayCardVisible,
    ).toBe(false);
  });
});

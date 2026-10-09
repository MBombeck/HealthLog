/**
 * Structural guard on the surface map (`src/lib/modules/surface.ts`).
 *
 * The map is the one answer to "which module owns this surface". It only
 * works if two things stay true, and each half of this file holds one:
 *
 *  1. Every id in the map names a surface that exists. A nav href, a slug, a
 *     section id, a widget id that was renamed would leave an entry that
 *     matches nothing, and the surface it meant would silently stop hiding.
 *     Each family is checked against the list the app actually renders from.
 *
 *  2. Every surface that shows a module's data is owned by that module. This
 *     half cannot come from the map itself, so it is derived from a second
 *     source: the measurement types each surface plots, joined against the
 *     summary owners the dashboard already gates on. A sleep page with no
 *     sleep entry, or a trends slot charting a recovery-owned series with no
 *     owner, fails here by name. A short table of owners that no data join
 *     can derive (nav pages, the add menu, overview blocks) is pinned below.
 *
 * Plus the retirement half: the per-surface maps and guard hooks this map
 * replaced must not come back, so their names are searched for in source.
 *
 * Limits, stated so nobody reads more into a green run: the data join only
 * sees surfaces that declare the types they plot, so a surface that reads a
 * module's store without declaring a type would pass. The source search
 * matches names, not behaviour; a copy under a new name passes. Every match
 * set asserts a non-zero count so a matcher that stopped matching fails.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// The capture picker and the Settings shell pull in forms and sections; the
// guard needs only their exported lists.
vi.mock("@/components/measurements/measurement-form", () => ({
  MeasurementForm: () => null,
}));
vi.mock("@/components/mood/mood-form", () => ({ MoodForm: () => null }));
vi.mock("@/components/dashboard/medication-intake-quick-add", () => ({
  MedicationIntakeQuickAdd: () => null,
}));

import {
  walkSourceFiles,
  stripComments,
} from "@/__tests__/helpers/source-files";
import { NAV_DESTINATIONS } from "@/components/layout/nav-model";
import { CAPTURE_KIND_ORDER } from "@/components/layout/capture-picker";
import { SETTINGS_SECTIONS } from "@/components/settings/settings-shell";
import { LAYOUT_GROUP_IDS } from "@/components/settings/layout-groups";
import {
  DASHBOARD_WIDGET_CATALOGUE_IDS,
  SCORE_RING_IDS,
} from "@/lib/dashboard-layout";
import { SUMMARY_TYPE_MODULE } from "@/lib/dashboard/widget-modules";
import { ENVIRONMENT_FIELDS } from "@/lib/environment/fields";
import {
  DISCOVERY_BEHAVIOURS,
  DISCOVERY_OUTCOMES,
  FACTOR_CHANNEL_PREFIX,
} from "@/lib/insights/correlation-discovery";
import { DERIVED_METRIC_IDS } from "@/lib/insights/derived/registry";
import { INSIGHTS_SECTION_IDS } from "@/lib/insights-layout";
import {
  SUB_PAGE_SLUGS,
  TYPE_TO_SUB_PAGE_SLUG,
} from "@/lib/insights/sub-page-metric";
import { TREND_CHART_CONFIG } from "@/lib/insights/trend-chart-select";
import { SYMPTOM_CHANNEL_PREFIX } from "@/lib/symptoms/shared";
import { DAY_SECTION_KEYS, TIMELINE_LANE_KEYS } from "@/lib/day/contract";
import {
  SURFACE_KINDS,
  SURFACE_MODULE,
  correlationChannelSurfaceId,
  surfaceModule,
  surfaceModulesOfKind,
  type SurfaceKind,
} from "@/lib/modules/surface";

const SRC = join(process.cwd(), "src");

function localIds(kind: SurfaceKind): string[] {
  const ids = Object.keys(surfaceModulesOfKind(kind));
  return ids;
}

describe("every surface id names a surface that exists", () => {
  it("covers every kind with at least one entry", () => {
    for (const kind of SURFACE_KINDS) {
      expect(localIds(kind).length, kind).toBeGreaterThan(0);
    }
  });

  it("nav: a destination href", () => {
    const hrefs = new Set(NAV_DESTINATIONS.map((d) => d.href));
    for (const id of localIds("nav")) expect(hrefs.has(id), id).toBe(true);
  });

  it("insights-page: a routed Insights sub-page", () => {
    for (const slug of localIds("insights-page")) {
      expect(
        existsSync(join(SRC, "app/insights", slug)),
        `src/app/insights/${slug}`,
      ).toBe(true);
    }
  });

  it("overview: an overview section id, or the cycle ring inside the scores strip", () => {
    const ids = new Set<string>([...INSIGHTS_SECTION_IDS, "cycle-ring"]);
    for (const id of localIds("overview")) expect(ids.has(id), id).toBe(true);
  });

  it("trend: a trends-row slot that charts something", () => {
    for (const id of localIds("trend")) {
      expect(
        TREND_CHART_CONFIG[id as keyof typeof TREND_CHART_CONFIG],
        id,
      ).toBeTruthy();
    }
  });

  it("capture: an add-menu kind", () => {
    const kinds = new Set<string>(CAPTURE_KIND_ORDER);
    for (const id of localIds("capture")) expect(kinds.has(id), id).toBe(true);
  });

  it("widget: a dashboard widget id", () => {
    const ids = new Set<string>(DASHBOARD_WIDGET_CATALOGUE_IDS);
    for (const id of localIds("widget")) expect(ids.has(id), id).toBe(true);
  });

  it("derived: a derived metric id", () => {
    const ids = new Set<string>(DERIVED_METRIC_IDS);
    for (const id of localIds("derived")) expect(ids.has(id), id).toBe(true);
  });

  it("score-ring: a hero score ring id, the derived ones owned like their score", () => {
    const ids = new Set<string>(SCORE_RING_IDS);
    for (const id of localIds("score-ring")) {
      expect(ids.has(id), id).toBe(true);
      const derivedOwner = surfaceModule(`derived:${id}`);
      if (derivedOwner !== undefined) {
        expect(surfaceModule(`score-ring:${id}`), id).toBe(derivedOwner);
      }
    }
  });

  it("settings: a Settings section slug", () => {
    const slugs = new Set<string>(SETTINGS_SECTIONS.map((s) => s.slug));
    for (const id of localIds("settings")) expect(slugs.has(id), id).toBe(true);
  });

  it("settings-layout: a Layout group id", () => {
    const ids = new Set<string>(LAYOUT_GROUP_IDS);
    for (const id of localIds("settings-layout")) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it("day-section: a section the day view renders", () => {
    const keys = new Set<string>(DAY_SECTION_KEYS);
    for (const id of localIds("day-section")) {
      expect(keys.has(id), id).toBe(true);
    }
  });

  it("timeline-lane: a lane the timeline renders", () => {
    const keys = new Set<string>(TIMELINE_LANE_KEYS);
    for (const id of localIds("timeline-lane")) {
      expect(keys.has(id), id).toBe(true);
    }
  });

  it("correlation: a discovery channel, a weather field or the lab pass", () => {
    const channels = new Set<string>([
      ...DISCOVERY_BEHAVIOURS,
      ...DISCOVERY_OUTCOMES,
      ...ENVIRONMENT_FIELDS.map((f) => f.key),
      "LAB_DRAWS",
    ]);
    for (const id of localIds("correlation")) {
      expect(channels.has(id), id).toBe(true);
    }
    // `correlationChannelSurfaceId` folds rated factors onto mood by this
    // prefix; it has to be the prefix the engine actually writes.
    expect(FACTOR_CHANNEL_PREFIX).toBe("FACTOR:");
    // Person-defined symptoms fold onto the illness symptom channel by theirs.
    expect(SYMPTOM_CHANNEL_PREFIX).toBe("SYMPTOM:");
    expect(correlationChannelSurfaceId(`${SYMPTOM_CHANNEL_PREFIX}abc`)).toBe(
      "correlation:SYMPTOM_SEVERITY",
    );
  });
});

describe("every surface that shows a module's data is owned by it", () => {
  /** Summary owners are the dashboard's own gate; the join source of truth. */
  const ownerOfType = (type: string) => SUMMARY_TYPE_MODULE[type];

  /**
   * Sub-pages a module-owned type routes to but that are not that module's.
   * Each carries its reason; an entry here is a decision, not a silence.
   */
  const NOT_OWNED_DESPITE_TYPE: Record<string, string> = {
    // The HRV page leads with SDNN, a plain vital. RMSSD is recovery-owned
    // and routes here only as the multi-metric fallback.
    hrv: "SDNN page; RMSSD is only its fallback series",
  };

  it("Insights sub-pages follow the owner of the types they plot", () => {
    let joined = 0;
    for (const [type, slug] of Object.entries(TYPE_TO_SUB_PAGE_SLUG)) {
      const owner = ownerOfType(type);
      if (!owner || slug in NOT_OWNED_DESPITE_TYPE) continue;
      joined += 1;
      expect(
        surfaceModule(`insights-page:${slug}`),
        `${slug} plots ${type}, which ${owner} owns`,
      ).toBe(owner);
    }
    expect(joined).toBeGreaterThan(0);
  });

  it("trends-row slots follow the owner of the series they chart", () => {
    let joined = 0;
    for (const [metric, config] of Object.entries(TREND_CHART_CONFIG)) {
      if (!config) continue;
      const owners = new Set(
        config.types.map(ownerOfType).filter((o) => o !== undefined),
      );
      if (config.kind === "mood") owners.add("mood");
      if (owners.size === 0) {
        expect(surfaceModule(`trend:${metric}`), metric).toBeUndefined();
        continue;
      }
      joined += 1;
      expect(owners.size, metric).toBe(1);
      expect(surfaceModule(`trend:${metric}`), metric).toBe([...owners][0]);
    }
    expect(joined).toBeGreaterThan(0);
  });

  it("correlation channels that are summary types follow the summary owner", () => {
    let joined = 0;
    for (const key of [...DISCOVERY_BEHAVIOURS, ...DISCOVERY_OUTCOMES]) {
      const owner = ownerOfType(key);
      if (!owner) continue;
      joined += 1;
      expect(surfaceModule(`correlation:${key}`), key).toBe(owner);
    }
    expect(joined).toBeGreaterThan(0);
  });

  it("every weather channel belongs to the environment module", () => {
    for (const field of ENVIRONMENT_FIELDS) {
      expect(surfaceModule(`correlation:${field.key}`), field.key).toBe(
        "environment",
      );
    }
  });

  // Owners no data join can derive. Pinned by hand; each is a surface the
  // audit found leaking when its module was off.
  it.each([
    ["nav:/mood", "mood"],
    ["nav:/cycle", "cycle"],
    ["nav:/medications", "medications"],
    ["nav:/labs", "labs"],
    ["nav:/coach", "coach"],
    ["insights-page:mood", "mood"],
    ["insights-page:medications", "medications"],
    ["insights-page:workouts", "workouts"],
    ["insights-page:recovery", "recovery"],
    ["insights-page:nutrients", "nutrients"],
    ["overview:breathing", "sleep"],
    ["overview:labs-changes", "labs"],
    ["overview:cycle-summary", "cycle"],
    ["overview:cycle-ring", "cycle"],
    ["capture:mood", "mood"],
    ["capture:medication", "medications"],
    ["capture:workout", "workouts"],
    ["capture:symptom", "illness"],
    ["capture:lifeEvent", "timeline"],
    ["trend:mood", "mood"],
    ["widget:medications", "medications"],
    ["correlation:MEDICATION_COMPLIANCE", "medications"],
    ["correlation:SYMPTOM_SEVERITY", "illness"],
    ["correlation:LAB_DRAWS", "labs"],
    ["nav:/timeline", "timeline"],
    ["day-section:lifeEvents", "timeline"],
    ["day-section:symptoms", "illness"],
    ["timeline-lane:documents", "inboundDocuments"],
  ])("%s is owned by %s", (id, owner) => {
    expect(surfaceModule(id)).toBe(owner);
  });

  it("the insights key owns nothing (it is AI analysis, not an area)", () => {
    expect(Object.values(SURFACE_MODULE)).not.toContain("insights");
  });

  it("the tab strip covers every sub-page slug it can render", () => {
    // Every owned sub-page that is a strip slug is reachable by the strip's
    // lookup; recovery is the one composite pill without a slug.
    const slugs = new Set<string>(SUB_PAGE_SLUGS);
    for (const id of localIds("insights-page")) {
      expect(slugs.has(id) || id === "recovery", id).toBe(true);
    }
  });
});

describe("the replaced maps and guards stay gone", () => {
  const files = walkSourceFiles(SRC, { floor: 1000 }).filter(
    (rel) =>
      !rel.startsWith("generated/") &&
      !rel.includes("__tests__/") &&
      !/\.test\.tsx?$/.test(rel),
  );
  const sources = files.map((rel) => ({
    rel,
    code: stripComments(readFileSync(join(SRC, rel), "utf8")),
  }));

  it.each([
    ["a per-destination module key", /\brequiresModule\s*[?:]/],
    ["a per-section module key", /\bmoduleGate\s*\?\s*:|\bmoduleGate\s*:\s*"/],
    ["the tab strip's own slug map", /\bSUB_PAGE_MODULE\b/],
    ["the redirecting page guard", /\buseModulePageGuard\b/],
  ])("no source declares %s", (_label, pattern) => {
    const hits = sources.filter((s) => pattern.test(s.code)).map((s) => s.rel);
    expect(hits).toEqual([]);
  });

  it("every discovery-matrix caller passes the record's module map", () => {
    // `modules` is a required option, so omitting it fails to compile; this
    // catches the other way to get it wrong, a hand-built map, by requiring
    // each calling file to resolve the record's own. A file that forwards a
    // map it received from its caller would need an entry here.
    const callers = sources.filter(
      (s) =>
        /\bassembleDiscoveryMatrix\s*\(/.test(s.code) &&
        s.rel !== "lib/insights/discovery-matrix.ts",
    );
    expect(callers.length).toBeGreaterThanOrEqual(4);
    for (const caller of callers) {
      expect(caller.code, caller.rel).toMatch(/\bresolveModuleMap\s*\(/);
      expect(caller.code, caller.rel).toMatch(
        /assembleDiscoveryMatrix\s*\([\s\S]*?\bmodules\b/,
      );
    }
  });

  it("the dashboard maps are views, built from the surface map and nowhere else", () => {
    const widgetModules = sources.find(
      (s) => s.rel === "lib/dashboard/widget-modules.ts",
    );
    expect(widgetModules).toBeDefined();
    expect(widgetModules!.code).toMatch(
      /WIDGET_MODULE_BY_ID[^=]*=\s*surfaceModulesOfKind\(\s*"widget"\s*\)/,
    );
    expect(widgetModules!.code).toMatch(
      /SUMMARY_TYPE_MODULE[^=]*=\s*surfaceModulesOfKind\(\s*"summary"\s*\)/,
    );
  });

  it("the derived-score gate agrees with the surface map", () => {
    // `DERIVED_MODULE` lives in the derived route, which this guard reads as
    // text rather than importing (it pulls the whole server stack). Parsed
    // entry by entry and compared, so a drift in either direction fails.
    const route = readFileSync(
      join(SRC, "app/api/insights/derived/route.ts"),
      "utf8",
    );
    const body = /DERIVED_MODULE[^=]*=\s*\{([\s\S]*?)\}/.exec(route)?.[1];
    expect(body).toBeDefined();
    const entries = Object.fromEntries(
      [...body!.matchAll(/([A-Z_]+)\s*:\s*"([A-Za-z]+)"/g)].map((m) => [
        m[1],
        m[2],
      ]),
    );
    expect(Object.keys(entries).length).toBeGreaterThan(0);
    expect(entries).toEqual(surfaceModulesOfKind("derived"));
  });
});

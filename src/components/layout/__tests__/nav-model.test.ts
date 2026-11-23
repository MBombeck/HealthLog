/**
 * v1.17.1 — the one navigation information-model.
 *
 * Pins the coherence contract the desktop sidebar and the mobile
 * bottom-nav both consume: one ordered destination list (so the two bars
 * tell one story), the Coach as a first-class destination on both
 * surfaces, cycle gated by the account flag, and an active-resolver that
 * prefers the most-specific sibling under `/insights`. (v1.18.0 —
 * Workouts and Recovery left the left nav for their Insights pills.)
 */
import { describe, expect, it } from "vitest";

import {
  BOTTOM_NAV_PRIMARY_SLOT_HREFS,
  NAV_DESTINATIONS,
  NAV_GROUPS,
  groupNavDestinations,
  navGroupLabelKey,
  NAV_UTILITY_DESTINATIONS,
  isNavDestinationActive,
  mobileMoreHubDestinations,
  visibleNavDestinations,
  visibleUtilityDestinations,
} from "../nav-model";

describe("nav-model destination list", () => {
  it("lists Coach as a first-class destination", () => {
    const hrefs = NAV_DESTINATIONS.map((d) => d.href);
    expect(hrefs).toContain("/coach");
  });

  it("gives the Coach exactly one nav home at the top-level /coach (F-3)", () => {
    const coach = NAV_DESTINATIONS.filter((d) => d.href === "/coach");
    expect(coach).toHaveLength(1);
    expect(coach[0]!.tKey).toBe("nav.coach");
  });

  it("lists the groups of #1113 in order, from the one group map", () => {
    expect(NAV_GROUPS.map((g) => g.id)).toEqual([
      "home",
      "tracking",
      "record",
      "analysis",
    ]);
    // The list is ordered by the map: a group's entries sit together, and
    // the groups follow NAV_GROUPS. An entry filed out of place fails here.
    const rank = (d: { group: string }) =>
      NAV_GROUPS.findIndex((g) => g.id === d.group);
    const ranks = NAV_DESTINATIONS.map(rank);
    expect(ranks.every((r) => r >= 0)).toBe(true);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(
      groupNavDestinations(NAV_DESTINATIONS).map((g) => [
        g.id,
        g.items.map((d) => d.href),
      ]),
    ).toEqual([
      ["home", ["/"]],
      [
        "tracking",
        [
          "/measurements",
          "/medications",
          "/mood",
          "/mental-wellbeing",
          "/cycle",
        ],
      ],
      [
        "record",
        [
          "/care",
          "/labs",
          "/profile",
          "/illness",
          "/seizures",
          "/vaccinations",
          "/documents",
          "/emergency-card",
        ],
      ],
      ["analysis", ["/timeline", "/insights", "/coach", "/achievements"]],
    ]);
  });

  it("a group whose entries are all switched off loses its heading", () => {
    const tracking = NAV_DESTINATIONS.filter((d) => d.group === "tracking");
    const rest = NAV_DESTINATIONS.filter((d) => d.group !== "tracking");
    expect(tracking.length).toBeGreaterThan(0);
    const groups = groupNavDestinations(rest).map((g) => g.id);
    expect(groups).not.toContain("tracking");
    expect(groupNavDestinations(rest).every((g) => g.items.length > 0)).toBe(
      true,
    );
  });

  it("with every module off, each heading still stands over an entry", () => {
    const off = Object.fromEntries(
      [
        "mood",
        "mentalHealth",
        "cycle",
        "medications",
        "labs",
        "illness",
        "seizures",
        "vaccinations",
        "inboundDocuments",
        "timeline",
        "coach",
        "achievements",
      ].map((key) => [key, false]),
    );
    const grouped = groupNavDestinations(visibleNavDestinations(off));
    expect(grouped.map((g) => g.id)).toEqual([
      "home",
      "tracking",
      "record",
      "analysis",
    ]);
    for (const group of grouped) expect(group.items.length).toBeGreaterThan(0);
    // Every heading has a name.
    for (const group of NAV_GROUPS.slice(1)) {
      expect(navGroupLabelKey(group.id)).toMatch(/^nav\.groups\./);
    }
  });

  it("every destination carries an i18n key under the nav namespace", () => {
    for (const d of NAV_DESTINATIONS) {
      expect(d.tKey.startsWith("nav.")).toBe(true);
    }
  });

  it("gives Checkups a top-level nav home in the clinical spine (N-3)", () => {
    const hrefs = NAV_DESTINATIONS.map((d) => d.href);
    expect(hrefs).toContain("/care");
    const vorsorge = NAV_DESTINATIONS.find((d) => d.href === "/care");
    expect(vorsorge?.tKey).toBe("nav.vorsorge");
    // Checkups opens the Health record group, after the Tracking group.
    expect(hrefs.indexOf("/medications")).toBeLessThan(hrefs.indexOf("/care"));
    expect(hrefs.indexOf("/care")).toBeLessThan(hrefs.indexOf("/labs"));
    expect(hrefs.indexOf("/labs")).toBeLessThan(hrefs.indexOf("/insights"));
  });

  it("does not list Recovery as a left-nav destination (it is an Insights pill)", () => {
    // v1.18.0 — Recovery moved off the left nav and surfaces as an
    // Insights tab-strip pill at `/insights/recovery` instead.
    const hrefs = NAV_DESTINATIONS.map((d) => d.href);
    expect(hrefs).not.toContain("/insights/recovery");
  });
});

describe("nav-model utility tail (N-1 — one shared list)", () => {
  it("every utility destination carries a nav-namespace i18n key", () => {
    for (const d of NAV_UTILITY_DESTINATIONS) {
      expect(d.tKey.startsWith("nav.")).toBe(true);
    }
  });

  it("lists the shared utility surfaces (Settings, Notifications)", () => {
    const hrefs = NAV_UTILITY_DESTINATIONS.map((d) => d.href);
    expect(hrefs).toContain("/settings/account");
    expect(hrefs).toContain("/notifications");
  });

  it("keeps a stable order (Settings → Notifications)", () => {
    const hrefs = visibleUtilityDestinations().map((d) => d.href);
    expect(hrefs.indexOf("/settings/account")).toBeLessThan(
      hrefs.indexOf("/notifications"),
    );
  });
});

describe("visibleNavDestinations module gate", () => {
  it("includes Cycle (after Mood, before Checkups) only when its module is enabled", () => {
    // v1.18.0 — cycle is owned by `cycle` in the surface map and reads the delegated
    // `cycle` key from the same resolved module map every other gate uses.
    // #1113 — cycle closes the Tracking group, after Mood.
    const off = visibleNavDestinations({ cycle: false }).map((d) => d.href);
    const on = visibleNavDestinations({ cycle: true }).map((d) => d.href);
    expect(off).not.toContain("/cycle");
    expect(on).toContain("/cycle");
    expect(on.indexOf("/mood")).toBeLessThan(on.indexOf("/cycle"));
    expect(on.indexOf("/cycle")).toBeLessThan(on.indexOf("/care"));
  });

  it("drops a module-gated entry (mood / labs / coach / achievements / medications) when its module is disabled", () => {
    const disabled = visibleNavDestinations({
      mood: false,
      labs: false,
      coach: false,
      achievements: false,
      // v1.18.1 — medications graduated to a toggleable module.
      medications: false,
    }).map((d) => d.href);
    expect(disabled).not.toContain("/mood");
    expect(disabled).not.toContain("/labs");
    expect(disabled).not.toContain("/coach");
    expect(disabled).not.toContain("/achievements");
    expect(disabled).not.toContain("/medications");
  });

  it("keeps Insights with AI analysis off: the insights key owns no destination", () => {
    const hrefs = visibleNavDestinations({ insights: false }).map(
      (d) => d.href,
    );
    expect(hrefs).toContain("/insights");
  });

  it("keeps every module-gated entry when its module is enabled", () => {
    const enabled = visibleNavDestinations({
      mood: true,
      labs: true,
      coach: true,
      achievements: true,
      insights: true,
      medications: true,
    }).map((d) => d.href);
    expect(enabled).toContain("/mood");
    expect(enabled).toContain("/labs");
    expect(enabled).toContain("/coach");
    expect(enabled).toContain("/achievements");
    expect(enabled).toContain("/insights");
    expect(enabled).toContain("/medications");
  });

  it("fails open: a missing key or an undefined map keeps the gated entry", () => {
    // Default-on contract — a stale /me payload (no module map) must not
    // blank the nav. An empty map and `undefined` both keep every entry.
    const emptyMap = visibleNavDestinations({}).map((d) => d.href);
    const noMap = visibleNavDestinations(undefined).map((d) => d.href);
    for (const hrefs of [emptyMap, noMap]) {
      expect(hrefs).toContain("/mood");
      expect(hrefs).toContain("/cycle");
      expect(hrefs).toContain("/labs");
      expect(hrefs).toContain("/coach");
      expect(hrefs).toContain("/achievements");
    }
    // Core / fail-open destinations render regardless of the map. Medications
    // is module-gated (v1.18.1 D3) but fails open on a missing key.
    expect(emptyMap).toContain("/measurements");
    expect(emptyMap).toContain("/medications");
    expect(emptyMap).toContain("/insights");
    expect(emptyMap).toContain("/care");
  });
});

describe("mobileMoreHubDestinations — the F-1 mobile invariant (feature-only hub, N-2)", () => {
  it("is exactly the visible feature destinations minus the primary slots (no utility tail)", () => {
    const opts = {
      modules: { cycle: false } as const,
    };
    const hub = mobileMoreHubDestinations(opts).map((d) => d.href);

    const expectedFeatures = visibleNavDestinations(opts.modules)
      .map((d) => d.href)
      .filter((href) => !BOTTOM_NAV_PRIMARY_SLOT_HREFS.includes(href));

    // Feature destinations only — the account utilities never ride the hub.
    expect(hub).toEqual(expectedFeatures);
  });

  it("never contains a primary slot (Home / Meds / Insights)", () => {
    const hub = mobileMoreHubDestinations({
      modules: { cycle: true },
    }).map((d) => d.href);
    for (const slot of BOTTOM_NAV_PRIMARY_SLOT_HREFS) {
      expect(hub).not.toContain(slot);
    }
  });

  it("keeps the feature destinations reachable but excludes the account utilities", () => {
    const hub = mobileMoreHubDestinations({
      modules: { cycle: false },
    }).map((d) => d.href);
    // Feature surfaces that left the always-visible strip stay reachable.
    expect(hub).toContain("/measurements");
    expect(hub).toContain("/mood");
    expect(hub).toContain("/care");
    // Settings + Notifications are account utilities — they live ONLY in the
    // user/avatar menu, never duplicated into the mobile More hub.
    expect(hub).not.toContain("/settings/account");
    expect(hub).not.toContain("/notifications");
  });

  it("gates Cycle by the module map, same as the sidebar", () => {
    const off = mobileMoreHubDestinations({
      modules: { cycle: false, mood: false },
    }).map((d) => d.href);
    const on = mobileMoreHubDestinations({
      modules: { cycle: true, mood: true },
    }).map((d) => d.href);
    expect(off).not.toContain("/cycle");
    expect(off).not.toContain("/mood");
    expect(on).toContain("/cycle");
    expect(on).toContain("/mood");
  });
});

describe("isNavDestinationActive most-specific resolution", () => {
  it("matches the dashboard only on an exact path", () => {
    expect(isNavDestinationActive("/", "/")).toBe(true);
    expect(isNavDestinationActive("/", "/measurements")).toBe(false);
  });

  it("lights up the top-level Coach home on its own route", () => {
    expect(isNavDestinationActive("/coach", "/coach")).toBe(true);
    // The standalone /coach route is not a sibling of /insights, so the
    // Insights entry must stay dark on it.
    expect(isNavDestinationActive("/insights", "/coach")).toBe(false);
  });

  it("lights up Insights on its Workouts sub-route (no longer a separate nav home)", () => {
    // v1.18.0 — Workouts left the left nav for its Insights pill, so it is
    // no longer a more-specific NAV_DESTINATIONS sibling. The Insights nav
    // home now reads active on `/insights/workouts`, like any other
    // `/insights/*` sub-route.
    expect(isNavDestinationActive("/insights", "/insights/workouts")).toBe(
      true,
    );
  });

  it("still lights up Insights on its own sub-routes", () => {
    expect(isNavDestinationActive("/insights", "/insights")).toBe(true);
    expect(isNavDestinationActive("/insights", "/insights/values/WEIGHT")).toBe(
      true,
    );
  });
});

import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { APIRequestContext } from "@playwright/test";

import { ADMIN_SECTION_SLUGS } from "@/components/admin/section-slugs";
import { SETTINGS_SECTION_SLUGS } from "@/components/settings/section-slugs";

import { expect, test } from "./setup/test";
import { MOBILE_ROUTES_STORAGE_STATE_PATH } from "./setup/global-setup";
import { MOBILE_ROUTES_ANALYTE } from "./setup/mobile-routes-fixture";
import {
  expectNoHorizontalOverflow,
  settleForOverflowMeasurement,
} from "./utils/horizontal-overflow";

/**
 * Every signed-in route, at an iPhone width, does not scroll sideways.
 *
 * `mobile-horizontal-overflow.spec.ts` sweeps five widths over four
 * content-heavy routes. This file is the breadth half: one width, every route.
 * It exists because the lab list panned sideways on a phone for weeks while
 * the guard was green — `/labs` was simply not on the list. A hand-kept list
 * goes stale the day a route is added, so the routes here are read from
 * `src/app` itself, and a route this file cannot open fails the run instead of
 * dropping out silently:
 *
 *   - a static route is visited as is;
 *   - a dynamic route needs an entry in `DYNAMIC_ROUTES` that turns its
 *     segments into concrete paths (a settings slug, a seeded record's id);
 *   - a route that cannot be swept signed in (auth, invitation, public
 *     share-link pages) is listed in `NOT_SIGNED_IN` with its reason.
 *
 * The account is `E2E_MOBILE_ROUTES`, which `globalSetup` fills with one or
 * two of everything (`mobile-routes-fixture.ts`): an empty page fits any
 * viewport and would prove nothing. It renders in German, the locale with the
 * longest common strings, and at 390 px — the iPhone width the lab list broke
 * at.
 */

const APP_DIR = join(process.cwd(), "src", "app");
const WIDTH = 390;

/** Route patterns that are not signed-in surfaces, and why. */
const NOT_SIGNED_IN: Record<string, string> = {
  "/auth/login": "the sign-in page; a session redirects away from it",
  "/auth/register": "registration; a session redirects away from it",
  "/invite/[token]":
    "an invitation landing page for somebody without an account",
  "/c/[token]": "the clinician share-link page, opened without a session",
  "/claim/[token]":
    "the managed-profile handover link, opened by the person without a session (covered by v142-managed-profile-handover.spec.ts)",
  "/confirm-access": "the re-proof page, reached only from a stale session",
  "/enroll-mfa": "the forced second-factor enrolment of a policy-bound account",
  "/onboarding": "the first-run setup flow; covered by setup-flow-*.spec.ts",
  "/onboarding/[step]":
    "the first-run setup flow; covered by setup-flow-*.spec.ts",
};

type Resolver = (api: APIRequestContext) => Promise<string[]>;

async function readData<T>(api: APIRequestContext, path: string): Promise<T> {
  const res = await api.get(path);
  expect(res.ok(), `${path} answered ${res.status()}`).toBe(true);
  return ((await res.json()) as { data: T }).data;
}

const firstId = (ids: Array<string | null | undefined>, what: string) => {
  const id = ids.find((value): value is string => Boolean(value));
  if (!id)
    throw new Error(`the fixture holds no ${what} — globalSetup seeds one`);
  return id;
};

/** Every dynamic route pattern under `src/app`, turned into real paths. */
const DYNAMIC_ROUTES: Record<string, Resolver> = {
  "/settings/[section]": async () =>
    SETTINGS_SECTION_SLUGS.map((slug) => `/settings/${slug}`),
  "/admin/[section]": async () =>
    ADMIN_SECTION_SLUGS.map((slug) => `/admin/${slug}`),
  // `LAYOUT_GROUP_IDS` lives beside React components the test runner cannot
  // load; `settings/layout/[module]` 404s an unknown group, so a stale entry
  // here fails on the status check below rather than passing quietly.
  "/settings/layout/[module]": async () =>
    [
      "dashboard",
      "insights",
      "medications",
      "mood",
      "labs",
      "illness",
      "vorsorge",
    ].map((group) => `/settings/layout/${group}`),
  "/insights/scores/[metric]": async () =>
    ["sleep", "readiness", "recovery", "stress", "strain"].map(
      (metric) => `/insights/scores/${metric}`,
    ),
  "/insights/values/[type]": async () => [
    "/insights/values/WEIGHT",
    "/insights/values/BLOOD_PRESSURE_SYS",
  ],
  "/labs/[biomarkerId]": async (api) => {
    const data = await readData<{
      results: Array<{ biomarkerId: string | null; analyte: string }>;
    }>(api, "/api/labs?limit=50");
    const id = firstId(
      data.results
        .filter((row) => row.analyte === MOBILE_ROUTES_ANALYTE)
        .map((row) => row.biomarkerId),
      "linked lab reading",
    );
    return [`/labs/${id}`];
  },
  "/labs/[biomarkerId]/values": async (api) =>
    (await DYNAMIC_ROUTES["/labs/[biomarkerId]"](api)).map(
      (path) => `${path}/values`,
    ),
  "/medications/[id]": async (api) => {
    const meds = await readData<Array<{ id: string }>>(api, "/api/medications");
    return [
      `/medications/${firstId(
        meds.map((m) => m.id),
        "medication",
      )}`,
    ];
  },
  "/medications/[id]/history": async (api) =>
    (await DYNAMIC_ROUTES["/medications/[id]"](api)).map(
      (path) => `${path}/history`,
    ),
  "/illness/[id]": async (api) => {
    const episodes = await readData<Array<{ id: string }>>(
      api,
      "/api/illness/episodes",
    );
    return [
      `/illness/${firstId(
        episodes.map((e) => e.id),
        "illness episode",
      )}`,
    ];
  },
  "/custom-metrics/[id]": async (api) => {
    const data = await readData<{ customMetrics: Array<{ id: string }> }>(
      api,
      "/api/custom-metrics",
    );
    const id = firstId(
      data.customMetrics.map((m) => m.id),
      "custom metric",
    );
    return [`/custom-metrics/${id}`];
  },
  "/custom-metrics/[id]/values": async (api) =>
    (await DYNAMIC_ROUTES["/custom-metrics/[id]"](api)).map(
      (path) => `${path}/values`,
    ),
  "/insights/workouts/[id]": async (api) => {
    const data = await readData<{ workouts: Array<{ id: string }> }>(
      api,
      "/api/workouts?limit=1",
    );
    return [
      `/insights/workouts/${firstId(
        data.workouts.map((w) => w.id),
        "workout",
      )}`,
    ];
  },
  // An ECG strip only arrives through a device sync; no route writes one. The
  // detail page is swept in its not-found state, which is still the frame,
  // header and back link a phone renders.
  "/insights/ecg/[id]": async () => ["/insights/ecg/unknown-recording"],
};

/** Every `page.tsx` under `src/app`, as a route pattern (`/labs/[biomarkerId]`). */
function discoverRoutePatterns(dir = APP_DIR): string[] {
  const patterns: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "api" || entry.startsWith("_") || entry === "__tests__")
        continue;
      patterns.push(...discoverRoutePatterns(full));
    } else if (entry === "page.tsx") {
      const rel = relative(APP_DIR, dir).split(sep).join("/");
      // Route groups `(name)` do not appear in the URL.
      const path = rel
        .split("/")
        .filter((segment) => segment && !/^\(.*\)$/.test(segment))
        .join("/");
      patterns.push(`/${path}`);
    }
  }
  return patterns.sort();
}

const PATTERNS = discoverRoutePatterns();
const isDynamic = (pattern: string) => pattern.includes("[");

test.describe("every signed-in route fits a phone", () => {
  test.use({ storageState: MOBILE_ROUTES_STORAGE_STATE_PATH });

  test.beforeEach(async ({ context }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "mobile-only spec");
    const baseURL = testInfo.project.use.baseURL ?? "http://localhost:3000";
    await context.addCookies([
      { name: "healthlog-locale", value: "de", url: baseURL },
    ]);
  });

  /**
   * The bookkeeping the sweep depends on. A new dynamic route without a
   * resolver, a resolver for a route that no longer exists, or an exclusion
   * for a route that is gone each fail here by name.
   */
  test("the swept routes are the routes the app has", () => {
    expect(PATTERNS.length, "no page.tsx found under src/app").toBeGreaterThan(
      50,
    );
    const unresolved = PATTERNS.filter(
      (p) => isDynamic(p) && !NOT_SIGNED_IN[p] && !DYNAMIC_ROUTES[p],
    );
    expect(
      unresolved,
      "dynamic route(s) with no entry in DYNAMIC_ROUTES or NOT_SIGNED_IN",
    ).toEqual([]);
    const stale = [
      ...Object.keys(DYNAMIC_ROUTES),
      ...Object.keys(NOT_SIGNED_IN),
    ].filter((p) => !PATTERNS.includes(p));
    expect(stale, "entries for routes that no longer exist").toEqual([]);
  });

  for (const pattern of PATTERNS) {
    if (NOT_SIGNED_IN[pattern]) continue;

    test(`${pattern} does not scroll sideways at ${WIDTH}px`, async ({
      page,
    }) => {
      test.slow();
      const paths = isDynamic(pattern)
        ? await DYNAMIC_ROUTES[pattern](page.request)
        : [pattern];
      expect(paths.length, `${pattern} resolved to no path`).toBeGreaterThan(0);

      await page.setViewportSize({ width: WIDTH, height: 844 });
      for (const path of paths) {
        const response = await page.goto(path, {
          waitUntil: "domcontentloaded",
        });
        expect(
          response?.status() ?? 0,
          `${path} answered ${response?.status()}`,
        ).toBeLessThan(400);
        // A redirect away (a module switched off, a missing record) would
        // measure some other page and call it this one.
        expect(new URL(page.url()).pathname, `${path} redirected`).toBe(
          new URL(path, page.url()).pathname,
        );
        await settleForOverflowMeasurement(page);
        await expectNoHorizontalOverflow(page, `${path} @${WIDTH}px`);
      }
    });
  }
});

/**
 * The lab surfaces, asserted at the elements that broke rather than only at
 * the page width. The list's name column collapsed to nothing on a phone
 * while the fixed columns beside it pushed the row off the card; the values
 * table put its edit and delete buttons in a sideways-scrolling strip.
 */
test.describe("the lab surfaces stay readable on a phone", () => {
  test.use({ storageState: MOBILE_ROUTES_STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "mobile-only spec");
    await page.setViewportSize({ width: WIDTH, height: 844 });
  });

  test("the lab list shows each marker's name", async ({ page }) => {
    await page.goto("/labs", { waitUntil: "domcontentloaded" });
    const names = page.locator('[data-slot="lab-list-analyte"]');
    await expect(names.first()).toBeVisible();
    const widths = await names.evaluateAll((nodes) =>
      nodes.map((node) => Math.round(node.getBoundingClientRect().width)),
    );
    expect(widths.length).toBeGreaterThan(1);
    // A readable name, not the 0 px column the fixed columns left it.
    for (const width of widths) expect(width).toBeGreaterThan(60);
  });

  test("the values list keeps its actions on screen", async ({ page }) => {
    const [path] = await DYNAMIC_ROUTES["/labs/[biomarkerId]/values"](
      page.request,
    );
    await page.goto(path, { waitUntil: "domcontentloaded" });
    const list = page.locator('[data-slot="lab-history-mobile-list"]');
    await expect(list).toBeVisible();
    await expect(page.locator('[data-slot="lab-history-table"]')).toBeHidden();

    const buttons = list.locator("button");
    expect(await buttons.count()).toBeGreaterThan(1);
    const outside = await buttons.evaluateAll(
      (nodes) =>
        nodes
          .map((node) => node.getBoundingClientRect())
          .filter((r) => r.left < 0 || r.right > window.innerWidth + 1).length,
    );
    expect(outside, "a reading's action sits off-screen").toBe(0);
  });
});

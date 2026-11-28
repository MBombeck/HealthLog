/**
 * An in-app link to a record kind or a metric page is built in one place,
 * `src/lib/links/hrefs.ts`.
 *
 * Before the registry, the same destination was spelled by hand wherever a
 * surface needed it, and the spellings drifted apart: a dose in the day view
 * opened `/medications/<id>/history`, a page that only shows a spinner and
 * redirects; a lab day on the timeline opened the bare `/labs` list while the
 * day view opened the marker; VO₂ max led to the pulse page from the briefing
 * and to cardio fitness from the dashboard tile, because four modules kept
 * their own table of metric pages.
 *
 * Three rules, all over code (comments are stripped):
 *
 *  1. The modules that hand links to the day view, the timeline, search, the
 *     briefing, the dashboard tiles, milestones and the metric deep links
 *     carry no route literal for a registered page at all. Each builds its
 *     links through the registry.
 *  2. Everywhere else in `src`, the number of such literals per file is a
 *     ratchet (`baselines/route-literals.json`): a file that gains one, or a
 *     new file that has one, fails. Navigation tables and page-local links
 *     that predate the registry sit in the baseline and may only shrink.
 *  3. The registry answers the questions the drift got wrong: one page per
 *     metric (VO₂ max included), dose links without the redirect, lab days on
 *     the marker or on the day, and every `?day=` link read by the day layer.
 *
 * Not matched, stated rather than hidden: a path assembled from parts
 * (`"/medi" + "cations"`), and a path held in a variable named elsewhere.
 * `/api/...` literals never match, because the page must follow the opening
 * quote directly. The care page (`/care`, `/checkups` on the wire) has its
 * own builder and guard (`visit-links.ts`, `care-wire-paths.test.ts`).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readSourceText,
  requireFloor,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";
import { runRatchet, writeBackHint } from "./helpers/ratchet";

const SRC = join(__dirname, "..");
const GUARD = "src/__tests__/route-literal-guard.test.ts";
const REGISTRY = "lib/links/hrefs.ts";

/** The pages the registry owns, as their first path segment. */
const REGISTERED_PAGES = [
  "medications",
  "illness",
  "labs",
  "mood",
  "seizures",
  "mental-wellbeing",
  "vaccinations",
  "documents",
  "insights",
  "cycle",
  "profile",
  "timeline",
  "measurements",
] as const;

/**
 * A route literal for a registered page: a string or template literal that
 * opens on the page and ends, queries, anchors, descends or interpolates
 * right after it; or a path built on the insights constant.
 */
const ROUTE_LITERAL = new RegExp(
  `["'\`]/(?:${REGISTERED_PAGES.join("|")})(?=["'\`?#/]|\\$\\{)|\\$\\{INSIGHTS_OVERVIEW_PATH\\}`,
  "g",
);

/** The modules that hand links out; each builds them through the registry. */
const PRODUCERS: Record<string, string> = {
  "lib/day/records.ts": "the day view's sections",
  "lib/day/taken-intakes.ts": "the day's taken doses",
  "lib/day/visit-preparation.ts": "what changed since the last visit",
  "lib/day/seizures-part.ts": "the day's seizures",
  "lib/timeline/lanes.ts": "the timeline lanes",
  "lib/search/search-records.ts": "search hits",
  "components/insights/daily-briefing.tsx": "the briefing's key findings",
  "components/dashboard/tile-destinations.ts": "the dashboard tiles",
  "lib/daily/milestones.ts": "a milestone's action",
  "lib/insights/metric-deep-link.ts": "`/insights?metric=` deep links",
};

function code(path: string): string {
  return stripComments(readSourceText(join(SRC, path)), path);
}

function count(source: string): number {
  return source.match(ROUTE_LITERAL)?.length ?? 0;
}

describe("route literals for registered pages", () => {
  it("the matcher sees literals and skips comments and other paths", () => {
    for (const hit of [
      'const a = "/labs";',
      "const b = `/medications/${id}/history`;",
      "const c = '/mood?from=2026-01-01';",
      'const d = "/insights/pulse";',
      "const e = `/illness${suffix}`;",
      "const f = `${INSIGHTS_OVERVIEW_PATH}/${slug}`;",
      'const g = "/insights#ecg";',
    ]) {
      expect(count(stripComments(hit, "x.ts")), hit).toBe(1);
    }
    for (const miss of [
      '// "/labs" in a line comment',
      "/** `/medications/<id>/history` in a docblock */",
      'const h = "/api/labs";',
      'const i = "/labsheet";',
      'const j = "nav:/mood";',
      'const k = "/moods";',
    ]) {
      expect(count(stripComments(miss, "x.ts")), miss).toBe(0);
    }
  });

  it("the registry itself spells the pages, or the matcher proves nothing", () => {
    expect(existsSync(join(SRC, REGISTRY)), REGISTRY).toBe(true);
    expect(count(code(REGISTRY))).toBeGreaterThan(10);
  });

  it("the link producers carry no route literal for a registered page", () => {
    const offenders = Object.keys(PRODUCERS)
      .map((path) => [path, count(code(path))] as const)
      .filter(([, n]) => n > 0)
      .map(([path, n]) => `${path}: ${n}`);
    expect(
      offenders,
      "Build the link with recordHref() / pageHref() / dayHref() / metricHref() from src/lib/links/hrefs.ts.",
    ).toEqual([]);
  });

  // Strips the comments of every source file once: slow on a loaded machine.
  it(
    "lets no route literal in elsewhere, and lets none grow",
    { timeout: 60_000 },
    () => {
      const files = walkSourceFiles(SRC, { floor: 2500 }).filter(
        (p) =>
          p !== REGISTRY &&
          !p.includes("__tests__/") &&
          !/\.test\.tsx?$/.test(p) &&
          !p.startsWith("generated/"),
      );
      const measured: Record<string, number> = {};
      for (const path of files) {
        const n = count(code(path));
        if (n > 0) measured[path] = n;
      }
      requireFloor("files with a route literal", Object.keys(measured), 50);
      const result = runRatchet("route-literals.json", measured, {
        comment:
          "Route literals for a page src/lib/links/hrefs.ts owns, per file under src outside the registry and tests. Maintained by src/__tests__/route-literal-guard.test.ts.",
      });
      expect(
        result.grew,
        "A route literal that is new or one more than its file had. Build the link with src/lib/links/hrefs.ts.",
      ).toEqual([]);
      expect(result.stale, writeBackHint(GUARD)).toEqual([]);
    },
  );
});

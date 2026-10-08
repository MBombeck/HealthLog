import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Where a date must NOT open the day (integration plan §1.2), frozen.
 *
 *   - the dashboard's today area: the dashboard is today; past days open as
 *     a layer over it, never as date navigation inside it. The dashboard's
 *     charts below it do open their days (the maintainer's call on the
 *     beta), like every chart drawn in days (`day-door-coverage-guard`);
 *   - a trend card: it shows the latest value and a direction, no day, and
 *     the whole tile leads to its metric page (the mini-chart side is
 *     pinned in `health-chart-day-links`);
 *   - the cycle calendar: a tap there has meant "log this day" for years;
 *   - model-written text (the briefing, the Coach's prose): never parsed for
 *     dates; the Coach's days come from its tool calls as chips;
 *   - the clinician share link and the doctor-report PDF: outside the
 *     session, a frozen window, another reader;
 *   - future dates: `DayLink` renders them as text (pinned in `day-link`).
 *
 * The check is an import of the day module (or the link markup) in any of
 * those files. Its own limit: a surface that builds `?day=` by hand would slip
 * it, which is why the second test looks for the parameter itself.
 */

const ROOT = join(__dirname, "..", "..", "..", "..");

const NOT_HERE: readonly string[] = [
  "src/components/daily/today-hero.tsx",
  "src/components/charts/trend-card.tsx",
  "src/components/cycle/cycle-calendar.tsx",
  "src/components/insights/daily-briefing.tsx",
  "src/components/insights/coach-panel/streamed-prose.tsx",
  "src/components/clinician",
  "src/app/c",
  "src/lib/doctor-report-pdf",
];

function files(path: string): string[] {
  const abs = join(ROOT, path);
  if (statSync(abs).isFile()) return [abs];
  return readdirSync(abs).flatMap((name) => files(join(path, name)));
}

const sources = NOT_HERE.flatMap(files).filter((f) => /\.tsx?$/.test(f));

describe("the day view stays out of the surfaces it must not reach", () => {
  it("covers every listed surface", () => {
    // A listed path that vanished or moved would leave the guard green by
    // matching nothing.
    expect(sources.length).toBeGreaterThanOrEqual(NOT_HERE.length);
  });

  it("none of them imports the day module", () => {
    const offenders = sources.filter((file) =>
      /from\s+["']@\/components\/day\//.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it("none of them spells a ?day= link by hand", () => {
    const offenders = sources.filter((file) =>
      /[?&]day=|DAY_QUERY_PARAM/.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it("the dashboard's today area hands no day door to its hero", () => {
    // The charts below the hero open their days; the hero itself is today
    // and stays on the list above. Pinned from the other side: the hero is
    // still mounted by the dashboard, so the list entry is not stale.
    const dashboard = readFileSync(
      join(ROOT, "src/app/page-client.tsx"),
      "utf8",
    );
    expect(dashboard).toMatch(/<TodayHero\b/);
  });
});

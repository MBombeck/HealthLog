import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { localDayKeyFor, openEndedFetchWindow } from "../fetch-window";

/**
 * A chart that shows "the last N days" asks for a window that must still hold
 * a reading saved after the chart mounted. The window used to end at the mount
 * instant, so the invalidated refetch asked for the same old window and a new
 * reading stayed invisible until the range tab was switched.
 */
function windowAt(now: Date, tz: string, days = 30) {
  return openEndedFetchWindow(days, localDayKeyFor(now, tz), tz);
}

function inside(w: { from: string; to: string }, at: Date) {
  return at >= new Date(w.from) && at <= new Date(w.to);
}

const previousTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = previousTz;
});

describe.each([
  ["Europe/Berlin", "UTC"],
  ["America/Los_Angeles", "America/Los_Angeles"],
  ["Pacific/Kiritimati", "Pacific/Kiritimati"],
])("open-ended chart window, profile %s, host %s", (profileTz, hostTz) => {
  it("holds a reading saved after the chart mounted, under the same key", () => {
    process.env.TZ = hostTz;
    const mountedAt = new Date("2026-10-03T08:00:00.000Z");
    const savedAt = new Date(mountedAt.getTime() + 5 * 60_000);

    const atMount = windowAt(mountedAt, profileTz);
    const afterSave = windowAt(savedAt, profileTz);

    expect(inside(atMount, savedAt)).toBe(true);
    // Same day, same window: the query key does not churn, and the
    // invalidation that follows a save refetches a window that holds it.
    expect(afterSave).toEqual(atMount);
  });

  it("moves on to the next local day by itself", () => {
    process.env.TZ = hostTz;
    const today = new Date("2026-10-03T08:00:00.000Z");
    const tomorrow = new Date(today.getTime() + 86_400_000);

    const w = windowAt(tomorrow, profileTz);

    expect(inside(w, tomorrow)).toBe(true);
    expect(w).not.toEqual(windowAt(today, profileTz));
  });

  it("spans the requested number of days", () => {
    process.env.TZ = hostTz;
    const w = windowAt(new Date("2026-10-03T08:00:00.000Z"), profileTz, 7);
    const span = new Date(w.to).getTime() - new Date(w.from).getTime();
    expect(span).toBe(7 * 86_400_000);
    expect(w.windowDays).toBe(7);
  });
});

describe("health chart wiring", () => {
  it("builds its fetch window from today's key, not the mount instant", () => {
    const chart = readFileSync(
      join(
        process.cwd(),
        "src/components/charts/health-chart/use-health-chart-series.ts",
      ),
      "utf8",
    );
    const memo = chart.slice(chart.indexOf("const fetchWindow = useMemo("));
    const body = memo.slice(0, memo.indexOf("}, ["));
    expect(body).toContain("openEndedFetchWindow(");
    expect(body).not.toMatch(/const to = new Date\(\)/);
    expect(memo).toMatch(/\}, \[[^\]]*todayKey[^\]]*\]\)/);
  });
});

/**
 * The day routes, answered in the contract's shape.
 *
 * The day itself (`GET /api/day/{date}`) and the index (`GET /api/day/index`)
 * are route mocks, so a journey pins the client: which door opens which day,
 * what the history does, where no door is. The server's own answers are
 * pinned by the integration suite.
 */
import type { Page, Route } from "@playwright/test";

function dayFixture(date: string) {
  return {
    date,
    tz: "Europe/Berlin",
    counts: { values: 2, entries: 1 },
    running: [
      {
        kind: "illness",
        section: "illness",
        id: "ep1",
        title: "Common cold",
        sub: null,
        since: date,
        until: null,
        dayIndex: 1,
        dayCount: null,
        href: "/illness",
      },
    ],
    values: [
      {
        type: "BLOOD_PRESSURE_SYS",
        value: 124,
        unit: "mmHg",
        at: `${date}T07:00:00.000Z`,
        source: "MANUAL",
        band: { lo: 118, hi: 128, n: 20 },
      },
      {
        type: "BLOOD_PRESSURE_DIA",
        value: 79,
        unit: "mmHg",
        at: `${date}T07:00:00.000Z`,
        source: "MANUAL",
        band: { lo: 76, hi: 82, n: 20 },
      },
    ],
    events: [
      {
        at: `${date}T07:00:00.000Z`,
        kind: "mood",
        section: "mood",
        id: "m1",
        title: "Mood: good",
        meta: null,
        note: null,
        docs: [],
        href: "/mood",
      },
    ],
    notable: [],
    sections: {},
  };
}

/**
 * Every day from `from` to `to`, each holding values: what the row of day
 * dots under a chart reads when the whole window has entries.
 */
function everyDay(from: string, to: string): Record<string, string[]> {
  const days: Record<string, string[]> = {};
  if (!from || !to) return days;
  const at = new Date(`${from}T12:00:00.000Z`);
  const end = new Date(`${to}T12:00:00.000Z`);
  while (at <= end) {
    days[at.toISOString().slice(0, 10)] = ["values"];
    at.setUTCDate(at.getUTCDate() + 1);
  }
  return days;
}

export async function mockDay(
  page: Page,
  options: { index?: "empty" | "full" } = {},
) {
  await page.route("**/api/day/**", async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/day/index") {
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      const days = options.index === "full" ? everyDay(from, to) : {};
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            from,
            to,
            days,
            // The first day of the window stands out: the rug draws a ring.
            notable: Object.keys(days).slice(0, 1),
          },
          error: null,
        }),
      });
      return;
    }
    const date = url.pathname.split("/").pop() ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: dayFixture(date), error: null }),
    });
  });
}

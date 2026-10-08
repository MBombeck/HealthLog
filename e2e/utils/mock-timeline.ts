import type { Page, Route } from "@playwright/test";

/**
 * Route mocks for the timeline (v1.42, #613): `GET /api/timeline`,
 * `GET /api/timeline/readiness` and `/api/life-events`, answered in the
 * shapes of `src/lib/day/contract.ts` from an invented record. Two records:
 * `full` (years of history in every lane) and `ready` (a thin record that
 * starts in May 2024, a medication without a start date, no life events, no
 * vaccinations), matching the two states the design was approved in.
 *
 * Every value here is made up.
 */

type Item = {
  id: string;
  kind: string;
  start: string;
  end: string | null;
  open: boolean;
  precision: "DAY" | "MONTH" | "YEAR";
  startKnown: boolean;
  label: string;
  sub: string | null;
  href: string | null;
};

function item(over: Partial<Item> & Pick<Item, "id" | "kind" | "start">): Item {
  return {
    end: null,
    open: false,
    precision: "DAY",
    startKnown: true,
    label: over.id,
    sub: null,
    href: null,
    ...over,
  };
}

/** A small deterministic generator, so every run draws the same lines. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function monthly(
  from: string,
  to: string,
  value: (i: number, monthKey: string) => number,
) {
  const out: Array<{ t: string; mean: number }> = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  let i = 0;
  while (y < ty || (y === ty && m <= tm)) {
    const key = `${y}-${String(m).padStart(2, "0")}-01`;
    out.push({ t: key, mean: Math.round(value(i, key) * 10) / 10 });
    i++;
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

function series(dataFrom: string, today: string) {
  const r = rng(11);
  const months = monthly(dataFrom, today, () => 0).length;
  return [
    {
      key: "BLOOD_PRESSURE_SYS",
      unit: "mmHg",
      granularity: "month",
      points: monthly(
        dataFrom,
        today,
        (i) => 147 - (18 * i) / months + (r() - 0.5) * 4,
      ),
    },
    {
      key: "BLOOD_PRESSURE_DIA",
      unit: "mmHg",
      granularity: "month",
      points: monthly(
        dataFrom,
        today,
        (i) => 92 - (10 * i) / months + (r() - 0.5) * 3,
      ),
    },
    {
      key: "WEIGHT",
      unit: "kg",
      granularity: "month",
      points: monthly(
        dataFrom,
        today,
        (i) => 89 - (6.5 * i) / months + (r() - 0.5) * 0.6,
      ),
    },
    {
      key: "RESTING_HEART_RATE",
      unit: "bpm",
      granularity: "month",
      points: monthly(dataFrom, today, (i, k) => {
        const month = Number(k.slice(5, 7));
        return (
          68 -
          (5 * i) / months +
          Math.sin((month / 12) * 6.28) * 1.2 +
          (r() - 0.5) * 1.2
        );
      }),
    },
  ];
}

export function fullTimeline(today: string) {
  const vaccinations = [
    "2020-06-10",
    "2021-05-20",
    "2021-07-01",
    "2021-12-10",
    "2022-10-15",
    "2023-10-20",
    "2024-03-20",
    "2024-04-25",
    "2024-10-18",
    "2025-10-10",
  ];
  const visits = [
    "2019-03-10",
    "2020-03-05",
    "2021-09-14",
    "2022-09-20",
    "2023-09-12",
    "2024-09-17",
    "2025-09-18",
    "2026-01-03",
    "2026-06-22",
  ];
  const documents = [
    "2019-03-12",
    "2020-03-06",
    "2021-09-15",
    "2022-09-21",
    "2022-11-09",
    "2023-02-20",
    "2023-09-13",
    "2024-09-18",
    "2025-03-14",
    "2025-09-19",
    "2026-01-03",
    "2026-06-23",
  ];
  return {
    zoom: "all",
    range: {
      from: "2019-01-01",
      to: `${today.slice(0, 4)}-12-31`,
      dataFrom: "2019-01-01",
    },
    lanes: [
      {
        key: "life",
        items: [
          item({
            id: "le-1",
            kind: "lifeEvent",
            start: "2021-05-14",
            label: "Geburt Tochter",
          }),
          item({
            id: "le-2",
            kind: "lifeEvent",
            start: "2023-09-01",
            precision: "MONTH",
            label: "Umzug",
          }),
          item({
            id: "le-3",
            kind: "lifeEvent",
            start: "2024-10-01",
            label: "Neue Stelle",
          }),
        ],
      },
      {
        key: "illness",
        items: [
          item({
            id: "ill-c",
            kind: "chronic",
            start: "2019-03-10",
            open: true,
            label: "Bluthochdruck",
            sub: "chronisch",
            href: "/illness",
          }),
          item({
            id: "ill-1",
            kind: "episode",
            start: "2020-09-01",
            end: "2020-10-20",
            label: "Schulter",
          }),
          item({
            id: "ill-2",
            kind: "episode",
            start: "2022-03-08",
            end: "2022-03-24",
            label: "COVID-19",
          }),
          item({
            id: "ill-3",
            kind: "episode",
            start: "2022-11-02",
            end: "2023-02-15",
            label: "Bandscheibe L4/L5",
          }),
          item({
            id: "ill-4",
            kind: "episode",
            start: "2024-08-10",
            end: "2024-08-16",
            label: "Magen-Darm",
          }),
          item({
            id: "ill-5",
            kind: "episode",
            start: "2025-12-31",
            end: "2026-01-08",
            label: "Erkältung",
          }),
        ],
      },
      {
        key: "allergies",
        items: [
          item({
            id: "al-1",
            kind: "allergy",
            start: "2018-01-01",
            open: true,
            label: "Gräserpollen",
            sub: "seit 2008",
          }),
          item({
            id: "al-2",
            kind: "allergy",
            start: "2020-07-15",
            open: true,
            label: "Penicillin",
          }),
        ],
      },
      {
        key: "medications",
        items: [
          item({
            id: "med-1",
            kind: "medication",
            start: "2019-04-02",
            open: true,
            label: "Ramipril",
            sub: "2,5 mg",
          }),
          item({
            id: "dose-1",
            kind: "doseChange",
            start: "2020-08-12",
            label: "Ramipril",
            sub: "5 mg",
          }),
          item({
            id: "med-2",
            kind: "medication",
            start: "2022-11-03",
            end: "2022-12-10",
            label: "Ibuprofen",
          }),
          item({
            id: "c-1",
            kind: "course",
            start: "2023-11-01",
            end: "2024-03-31",
            label: "Vitamin D (Winter)",
          }),
          item({
            id: "c-2",
            kind: "course",
            start: "2024-11-01",
            end: "2025-03-31",
            label: "Vitamin D (Winter)",
          }),
          item({
            id: "c-3",
            kind: "course",
            start: "2025-11-01",
            end: "2026-03-31",
            label: "Vitamin D (Winter)",
          }),
        ],
      },
      {
        key: "vaccinations",
        items: vaccinations.map((d, i) =>
          item({
            id: `vac-${i}`,
            kind: "vaccination",
            start: d,
            label: "Impfung",
          }),
        ),
      },
      {
        key: "visits",
        items: [
          ...visits.map((d, i) =>
            item({
              id: `v-${i}`,
              kind: "visit",
              start: d,
              label: "Hausarztpraxis",
            }),
          ),
          item({
            id: "p-1",
            kind: "procedure",
            start: "2022-11-08",
            label: "MRT Lendenwirbelsäule",
          }),
          item({
            id: "p-2",
            kind: "procedure",
            start: "2025-03-12",
            label: "Darmspiegelung",
          }),
        ],
      },
      {
        key: "documents",
        items: documents.map((d, i) =>
          item({ id: `doc-${i}`, kind: "document", start: d, label: "Befund" }),
        ),
      },
    ],
    standing: [],
    series: series("2019-01-01", today),
    notable: [{ date: "2026-01-04", kind: "extremeHigh" }],
  };
}

export function readyTimeline(today: string) {
  return {
    zoom: "all",
    range: {
      from: "2024-01-01",
      to: `${today.slice(0, 4)}-12-31`,
      dataFrom: "2024-05-01",
    },
    lanes: [
      {
        key: "illness",
        items: [
          item({
            id: "ill-c",
            kind: "chronic",
            start: "2019-03-10",
            open: true,
            label: "Bluthochdruck",
            sub: "chronisch",
          }),
          item({
            id: "ill-4",
            kind: "episode",
            start: "2024-08-10",
            end: "2024-08-16",
            label: "Magen-Darm",
          }),
          item({
            id: "ill-5",
            kind: "episode",
            start: "2025-12-31",
            end: "2026-01-08",
            label: "Erkältung",
          }),
        ],
      },
      {
        key: "medications",
        items: [
          item({
            id: "med-1",
            kind: "medication",
            start: "2024-05-01",
            open: true,
            startKnown: false,
            label: "Ramipril",
            sub: "5 mg",
          }),
          item({
            id: "c-2",
            kind: "course",
            start: "2024-11-01",
            end: "2025-03-31",
            label: "Vitamin D (Winter)",
          }),
          item({
            id: "c-3",
            kind: "course",
            start: "2025-11-01",
            end: "2026-03-31",
            label: "Vitamin D (Winter)",
          }),
        ],
      },
      {
        key: "visits",
        items: [
          item({
            id: "v-1",
            kind: "visit",
            start: "2024-09-17",
            label: "Hausarztpraxis",
          }),
          item({
            id: "p-2",
            kind: "procedure",
            start: "2025-03-12",
            label: "Darmspiegelung",
          }),
          item({
            id: "v-2",
            kind: "visit",
            start: "2025-09-18",
            label: "Hausarztpraxis",
          }),
          item({
            id: "v-3",
            kind: "visit",
            start: "2026-01-03",
            label: "Hausarztpraxis",
          }),
          item({
            id: "v-4",
            kind: "visit",
            start: "2026-06-22",
            label: "Hausarztpraxis",
          }),
        ],
      },
      {
        key: "documents",
        items: [
          "2024-09-18",
          "2025-03-14",
          "2025-09-19",
          "2026-01-03",
          "2026-06-23",
        ].map((d, i) =>
          item({ id: `doc-${i}`, kind: "document", start: d, label: "Befund" }),
        ),
      },
    ],
    standing: [],
    series: series("2024-05-01", today).filter(
      (s) => s.key !== "RESTING_HEART_RATE",
    ),
    notable: [],
  };
}

export function fullReadiness() {
  return {
    verdict: "carries",
    since: "2019-03-01",
    lanes: [
      {
        key: "values",
        status: "carries",
        count: 3,
        detail: { key: "values", params: { count: 3, since: "2019-03-01" } },
        gaps: [],
      },
      {
        key: "illness",
        status: "carries",
        count: 6,
        detail: { key: "illness", params: { count: 6, chronic: 1 } },
        gaps: [],
      },
      {
        key: "visits",
        status: "carries",
        count: 11,
        detail: { key: "visits", params: { count: 11, procedures: 2 } },
        gaps: [],
      },
      {
        key: "documents",
        status: "carries",
        count: 14,
        detail: { key: "documents", params: { count: 14 } },
        gaps: [],
      },
      {
        key: "labs",
        status: "carries",
        count: 5,
        detail: { key: "labs", params: { count: 5 } },
        gaps: [],
      },
      {
        key: "medications",
        status: "thin",
        count: 5,
        detail: { key: "medications", params: { count: 5, missingStart: 3 } },
        gaps: [
          { key: "medicationsWithoutStart", count: 3, href: "/medications" },
        ],
      },
      {
        key: "vaccinations",
        status: "empty",
        count: 0,
        detail: { key: "empty", params: {} },
        gaps: [{ key: "vaccinationsEmpty", count: 0, href: "/vaccinations" }],
      },
      {
        key: "life",
        status: "empty",
        count: 0,
        detail: null,
        gaps: [
          { key: "lifeEventsEmpty", count: 0, href: "/timeline?add=lifeEvent" },
        ],
      },
    ],
  };
}

export function readyReadiness() {
  return {
    verdict: "carries",
    since: "2024-05-01",
    lanes: [
      {
        key: "values",
        status: "carries",
        count: 2,
        detail: { key: "values", params: { count: 2, since: "2024-05-01" } },
        gaps: [],
      },
      {
        key: "illness",
        status: "carries",
        count: 3,
        detail: { key: "illness", params: { count: 3, chronic: 1 } },
        gaps: [],
      },
      {
        key: "visits",
        status: "carries",
        count: 5,
        detail: { key: "visits", params: { count: 5, procedures: 1 } },
        gaps: [],
      },
      {
        key: "documents",
        status: "carries",
        count: 5,
        detail: { key: "documents", params: { count: 5 } },
        gaps: [],
      },
      {
        key: "medications",
        status: "thin",
        count: 3,
        detail: { key: "medications", params: { count: 3, missingStart: 3 } },
        gaps: [
          { key: "medicationsWithoutStart", count: 3, href: "/medications" },
        ],
      },
      {
        key: "life",
        status: "empty",
        count: 0,
        detail: null,
        gaps: [
          { key: "lifeEventsEmpty", count: 0, href: "/timeline?add=lifeEvent" },
        ],
      },
      {
        key: "vaccinations",
        status: "empty",
        count: 0,
        detail: { key: "empty", params: {} },
        gaps: [{ key: "vaccinationsEmpty", count: 0, href: "/vaccinations" }],
      },
    ],
  };
}

const LIFE_EVENTS = [
  {
    id: "le-1",
    category: "FAMILY",
    startDate: "2021-05-14",
    endDate: null,
    precision: "DAY",
    title: "Geburt Tochter",
    note: null,
  },
  {
    id: "le-2",
    category: "HOME",
    startDate: "2023-09-01",
    endDate: null,
    precision: "MONTH",
    title: "Umzug",
    note: null,
  },
  {
    id: "le-3",
    category: "WORK",
    startDate: "2024-10-01",
    endDate: null,
    precision: "DAY",
    title: "Neue Stelle",
    note: null,
  },
].map((e) => ({
  ...e,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}));

function json(route: Route, status: number, data: unknown) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify({ data, error: null }),
  });
}

export interface TimelineMockLog {
  timelineQueries: URLSearchParams[];
  lifeEventPosts: unknown[];
}

/**
 * Answer the timeline routes from the `full` or `ready` record. Returns a
 * log of what the page asked for and posted, for assertions.
 */
export async function mockTimeline(
  page: Page,
  state: "full" | "ready",
  today: string,
): Promise<TimelineMockLog> {
  const log: TimelineMockLog = { timelineQueries: [], lifeEventPosts: [] };
  await page.route(/\/api\/timeline\/readiness(\?|$)/, (route) =>
    json(route, 200, state === "full" ? fullReadiness() : readyReadiness()),
  );
  await page.route(/\/api\/timeline(\?|$)/, (route) => {
    const url = new URL(route.request().url());
    log.timelineQueries.push(url.searchParams);
    const body = state === "full" ? fullTimeline(today) : readyTimeline(today);
    const values = (url.searchParams.get("values") ?? "")
      .split(",")
      .filter(Boolean);
    return json(route, 200, {
      ...body,
      zoom: url.searchParams.get("zoom") ?? "all",
      series: body.series.filter((s) => values.includes(s.key)),
    });
  });
  await page.route(/\/api\/life-events(\/[^/?]+)?(\?|$)/, async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      return json(route, 200, { events: state === "full" ? LIFE_EVENTS : [] });
    }
    if (method === "POST") {
      const posted = route.request().postDataJSON() as Record<string, unknown>;
      log.lifeEventPosts.push(posted);
      return json(route, 201, {
        id: "le-new",
        endDate: null,
        note: null,
        ...posted,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      });
    }
    return json(route, 200, { deleted: true });
  });
  return log;
}

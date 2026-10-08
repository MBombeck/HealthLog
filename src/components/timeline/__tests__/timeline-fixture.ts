/**
 * A made-up record for the timeline tests: a chronic condition and several
 * episodes, two allergies, a standing medication with a dose change, a winter
 * course three years running, a medication whose start is unknown, visits
 * with two procedures, documents, vaccinations and three life events. All
 * data invented.
 */
import type {
  TimelineItem,
  TimelineReadinessResponse,
  TimelineResponse,
} from "@/lib/day/contract";

export function item(
  over: Partial<TimelineItem> & Pick<TimelineItem, "id" | "kind" | "start">,
): TimelineItem {
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

export const TODAY = "2026-10-07";

export function fullTimeline(): TimelineResponse {
  return {
    zoom: "all",
    range: { from: "2019-01-01", to: "2026-12-31", dataFrom: "2019-01-01" },
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
            id: "ill-chronic",
            kind: "chronic",
            start: "2019-03-10",
            open: true,
            label: "Bluthochdruck",
            sub: "chronisch",
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
            id: "course-1",
            kind: "course",
            start: "2023-11-01",
            end: "2024-03-31",
            label: "Vitamin D (Winter)",
          }),
          item({
            id: "course-2",
            kind: "course",
            start: "2024-11-01",
            end: "2025-03-31",
            label: "Vitamin D (Winter)",
          }),
          item({
            id: "course-3",
            kind: "course",
            start: "2025-11-01",
            end: "2026-03-31",
            label: "Vitamin D (Winter)",
          }),
          item({
            id: "pause-1",
            kind: "pause",
            start: "2021-06-01",
            end: "2021-06-20",
            label: "Pause",
          }),
        ],
      },
      {
        key: "vaccinations",
        items: [
          "2020-06-10",
          "2021-05-20",
          "2021-07-01",
          "2022-10-15",
          "2024-10-18",
          "2025-10-10",
        ].map((d, i) =>
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
          item({
            id: "v-1",
            kind: "visit",
            start: "2019-03-10",
            label: "Hausarztpraxis",
          }),
          item({
            id: "v-2",
            kind: "procedure",
            start: "2022-11-08",
            label: "MRT Lendenwirbelsäule",
          }),
          item({
            id: "v-3",
            kind: "procedure",
            start: "2025-03-12",
            label: "Darmspiegelung",
          }),
          item({
            id: "v-4",
            kind: "visit",
            start: "2026-01-03",
            label: "Hausarztpraxis",
          }),
        ],
      },
      { key: "labs", items: [] },
      {
        key: "documents",
        items: ["2019-03-12", "2022-11-09", "2026-01-03"].map((d, i) =>
          item({ id: `doc-${i}`, kind: "document", start: d, label: "Befund" }),
        ),
      },
    ],
    standing: [],
    series: [
      {
        key: "BLOOD_PRESSURE_SYS",
        unit: "mmHg",
        granularity: "month",
        points: [
          { t: "2025-10-01", mean: 127 },
          { t: "2025-11-01", mean: 128 },
          { t: "2025-12-01", mean: 130 },
          { t: "2026-01-01", mean: 129 },
          // Nothing for February to June.
          { t: "2026-07-01", mean: 131 },
        ],
      },
      {
        key: "BLOOD_PRESSURE_DIA",
        unit: "mmHg",
        granularity: "month",
        points: [{ t: "2026-01-01", mean: 82 }],
      },
      {
        key: "WEIGHT",
        unit: "kg",
        granularity: "month",
        points: [{ t: "2026-01-01", mean: 82.6 }],
      },
    ],
    notable: [{ date: "2026-01-04", kind: "extremeHigh" }],
  };
}

export function readiness(
  over: Partial<TimelineReadinessResponse> = {},
): TimelineReadinessResponse {
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
        key: "life",
        status: "empty",
        count: 0,
        detail: { key: "emptyLife", params: {} },
        gaps: [
          { key: "lifeEventsEmpty", count: 0, href: "/timeline?add=lifeEvent" },
        ],
      },
      {
        key: "illness",
        status: "carries",
        count: 6,
        detail: { key: "illness", params: { count: 6, chronic: 1 } },
        gaps: [],
      },
      {
        key: "medications",
        status: "thin",
        count: 5,
        detail: { key: "medications", params: { count: 5, missingStart: 3 } },
        gaps: [
          {
            key: "medicationsWithoutStart",
            count: 3,
            href: "/medications/med-1?edit=1",
          },
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
        key: "visits",
        status: "carries",
        count: 11,
        detail: { key: "visits", params: { count: 11, procedures: 2 } },
        gaps: [],
      },
    ],
    ...over,
  };
}

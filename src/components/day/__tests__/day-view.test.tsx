import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import enMessages from "../../../../messages/en.json";

import type { DayResponse } from "@/lib/day/contract";

/**
 * The day's content in every shell: header, sections in the mockup's order,
 * the footer's two ways onward, and the honest states (loading, failed,
 * empty, partly shared). Rendered through SSR against a `GET /api/day/{date}`
 * answer shaped by the contract, as the server will send it.
 */

const DAY: DayResponse = {
  date: "2026-01-03",
  tz: "Europe/Berlin",
  counts: { values: 3, entries: 2 },
  running: [
    {
      kind: "illness",
      section: "illness",
      id: "ep1",
      title: "Common cold",
      sub: null,
      since: "2025-12-31",
      until: null,
      dayIndex: 4,
      dayCount: null,
      href: "/illness/ep1",
    },
    {
      kind: "medicationCourse",
      section: "medications",
      id: "c1",
      title: "Vitamin D 1,000 IU",
      sub: "Winter course",
      since: "2025-11-01",
      until: "2026-03-31",
      dayIndex: 64,
      dayCount: 151,
      href: "/medications/m1?tab=verlauf",
    },
  ],
  values: [
    {
      type: "BLOOD_PRESSURE_DIA",
      value: 88,
      unit: "mmHg",
      at: "2026-01-03T06:12:00.000Z",
      source: "MANUAL",
      band: { lo: 78, hi: 86, n: 28 },
    },
    {
      type: "BLOOD_PRESSURE_SYS",
      value: 138,
      unit: "mmHg",
      at: "2026-01-03T06:12:00.000Z",
      source: "MANUAL",
      band: { lo: 121, hi: 134, n: 28 },
    },
    {
      type: "WEIGHT",
      value: 82.6,
      unit: "kg",
      at: "2026-01-03T06:20:00.000Z",
      source: "WITHINGS",
      band: null,
    },
  ],
  events: [
    {
      at: "2026-01-03T10:20:00.000Z",
      kind: "visit",
      section: "visits",
      id: "v1",
      title: "GP practice",
      meta: "Acute appointment",
      note: null,
      docs: [{ id: "d1", name: "sick-note.pdf" }],
      href: "/checkups?visit=v1",
    },
    {
      at: "2026-01-03T20:10:00.000Z",
      kind: "mood",
      section: "mood",
      id: "m1",
      title: "Mood: rather low",
      meta: "tired",
      note: "Fever gone by the evening.",
      docs: [],
      href: "/mood",
    },
  ],
  notable: [
    {
      kind: "extremeHigh",
      type: "BLOOD_PRESSURE_SYS",
      params: { since: "2025-03-01", value: 138 },
    },
  ],
  sections: {},
};

let dayQuery: { data?: DayResponse; isError?: boolean } = { data: DAY };
let timelineOn = true;
let pathname = "/insights/blood-pressure";
let canWrite = true;

vi.mock("../use-day", () => ({
  useDay: () => ({ ...dayQuery, refetch: () => undefined }),
  usePrefetchDay: () => () => undefined,
  useDayIndex: () => ({ data: undefined }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, user: { modules: {} } }),
}));
vi.mock("@/hooks/use-module-enabled", () => ({
  useModuleEnabled: (key: string) => (key === "timeline" ? timelineOn : true),
}));
vi.mock("@/hooks/use-ai-capability", () => ({
  useAiCapability: () => ({ available: false, reason: "check_failed" }),
}));
vi.mock("@/hooks/use-unit-display", () => ({
  useUnitDisplay: () => ({
    toDisplay: (_t: string, v: number) => v,
    unitFor: (t: string) => (t === "WEIGHT" ? "kg" : "mmHg"),
    decimalsFor: () => 1,
    isTransformed: (t: string) => t === "WEIGHT",
  }),
}));
vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({
    inSharedRecord: false,
    canWriteDomain: () => canWrite,
  }),
}));
vi.mock("@/components/layout/capture-picker", () => ({
  CAPTURE_KIND_ORDER: ["measurement", "mood"],
  CapturePicker: () => null,
  visibleCaptureKinds: (caps: { canWriteDomain: () => boolean }) =>
    caps.canWriteDomain() ? ["measurement"] : [],
}));

async function render(
  props: Partial<{
    date: string;
    today: string;
    focus: unknown;
    shell: "docked" | "sheet" | "bottom";
  }> = {},
) {
  const { I18nProvider } = await import("@/lib/i18n/context");
  const { DayView } = await import("../day-view");
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en" initialMessages={enMessages}>
      <DayView
        date={props.date ?? "2026-01-03"}
        today={props.today ?? "2026-10-08"}
        focus={(props.focus as never) ?? null}
        shell={props.shell ?? "docked"}
        onClose={() => undefined}
        onStep={() => undefined}
        onPick={() => undefined}
        Title={(p) => <h2 {...p} />}
        titleId="t"
      />
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.resetModules();
  dayQuery = { data: DAY };
  timelineOn = true;
  pathname = "/insights/blood-pressure";
  canWrite = true;
});

describe("<DayView>", () => {
  it("names the day and counts what it holds", async () => {
    const html = await render();
    expect(html).toContain("Saturday, January 3, 2026");
    expect(html).toContain("3 values, 2 entries");
  });

  it("lists what ran through the day with its running count", async () => {
    const html = await render();
    expect(html).toContain("Running that day");
    expect(html).toContain("Common cold");
    expect(html).toContain("Day 4 · since");
    expect(html).toContain("Winter course · Day 64 of 151");
    expect(html).toContain('href="/illness/ep1"');
  });

  it("states no day count for a record without a start, and words a life event's category", async () => {
    dayQuery = {
      data: {
        ...DAY,
        running: [
          {
            kind: "medication",
            section: "medications",
            id: "m9",
            title: "Levothyroxine",
            sub: "50 µg",
            since: null,
            until: null,
            dayIndex: null,
            dayCount: null,
            href: "/medications/m9",
          },
          {
            kind: "lifeEvent",
            section: "lifeEvents",
            id: "le1",
            title: "Parental leave",
            sub: "FAMILY",
            since: "2025-12-01",
            until: "2026-02-28",
            dayIndex: 34,
            dayCount: 90,
            href: null,
          },
        ],
      },
    };
    const html = await render();
    const rows = html.split('data-slot="day-running-item"').slice(1);
    const med = rows.find((row) => row.includes("Levothyroxine")) ?? "";
    expect(med).toContain("50 µg");
    expect(med.split("</li>")[0]).not.toMatch(/Day \d|since/);
    const leave = rows.find((row) => row.includes("Parental leave")) ?? "";
    expect(leave).toContain("Family · Day 34 of 90");
    expect(leave).not.toContain("FAMILY");
  });

  it("collapses the docked day and closes a sheet, and says which", async () => {
    const docked = await render();
    const hide = docked.match(/<button[^>]*data-slot="day-close"[^>]*>/)?.[0];
    expect(hide).toContain('aria-label="Hide day"');
    expect(hide).toContain('aria-expanded="true"');
    for (const shell of ["sheet", "bottom"] as const) {
      const sheet = await render({ shell });
      const close = sheet.match(/<button[^>]*data-slot="day-close"[^>]*>/)?.[0];
      expect(close).toContain('aria-label="Close day"');
      expect(close).not.toContain("aria-expanded");
    }
  });

  it("folds the blood pressure into one tile on its number line", async () => {
    const html = await render();
    expect(html).toContain('data-type="BLOOD_PRESSURE"');
    expect(html).toContain("138/88");
    expect(html).toContain('data-slot="day-number-line"');
    // A value without a band has no line, never an invented one.
    const weightTile = html.split('data-type="WEIGHT"')[1] ?? "";
    expect(weightTile.split("</li>")[0]).not.toContain("day-number-line");
  });

  it("lists what happened, each entry linking to its source", async () => {
    const html = await render();
    expect(html).toContain("What happened");
    expect(html).toContain('href="/checkups?visit=v1"');
    expect(html).toContain('href="/documents?doc=d1"');
    // The person's own note, in the content colour.
    expect(html).toContain("Fever gone by the evening.");
  });

  it("puts the value the person came from on top and marks its tile", async () => {
    const html = await render({
      focus: {
        date: "2026-01-03",
        types: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
        label: "Blood pressure",
        value: "138/88",
        unit: "mmHg",
      },
    });
    expect(html).toContain('data-slot="day-focus"');
    expect(html).toContain("Your 30 days before");
    expect(html).toContain("121–134/78–86");
    expect(html).toContain('data-selected="true"');
    expect(html).toContain("Highest daily value since March 2025");
  });

  it("offers the timeline only with its module on, and not on the timeline", async () => {
    expect(await render()).toContain('data-slot="day-in-timeline"');
    timelineOn = false;
    expect(await render()).not.toContain('data-slot="day-in-timeline"');
    timelineOn = true;
    pathname = "/timeline";
    expect(await render()).not.toContain('data-slot="day-in-timeline"');
  });

  it("offers capture only to someone who may write", async () => {
    expect(await render()).toContain('data-slot="day-capture"');
    canWrite = false;
    expect(await render()).not.toContain('data-slot="day-capture"');
  });

  it("never steps past today", async () => {
    const html = await render({ date: "2026-10-08", today: "2026-10-08" });
    expect(html).toMatch(/data-slot="day-next"[^>]*disabled=""/);
  });

  it("keeps a failed read apart from an empty day", async () => {
    dayQuery = { isError: true };
    const failed = await render();
    expect(failed).toContain('data-slot="day-error"');
    expect(failed).not.toContain('data-slot="day-empty"');

    dayQuery = {
      data: {
        ...DAY,
        counts: { values: 0, entries: 0 },
        running: [],
        values: [],
        events: [],
        notable: [],
      },
    };
    const empty = await render();
    expect(empty).toContain("There are no entries for this day.");
    expect(empty).not.toContain('data-slot="day-error"');
  });

  it("paints the frame while loading", async () => {
    dayQuery = {};
    const html = await render();
    expect(html).toContain('data-slot="day-loading"');
    expect(html).toContain("Saturday, January 3, 2026");
  });

  it("says once that some areas are not shared", async () => {
    dayQuery = {
      data: {
        ...DAY,
        sections: { labs: { available: false, reason: "not_shared" } },
      },
    };
    expect(await render()).toContain("Some areas are not shared with you.");
  });
});

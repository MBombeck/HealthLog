/**
 * v1.42 (#613) — no code reaches the screen. The timeline and the day view
 * receive what the record holds: a life event's category, a visit's kind, a
 * document's kind, an allergy's severity, a mood, a screener's instrument and
 * band as their codes, a lab day's analyte count as a bare number, and a
 * sentinel for a trip or a cycle. Every one of them is worded in the reader's
 * language before it is shown.
 *
 * This renders a record with every item kind, every category and every kind
 * code on every surface that shows it (the chronicle, the selection bar, the
 * screen-reader table, the lane labels and their hover titles, the day's
 * running items and its events) and asserts that the visible text holds no
 * upper-case code and no sentinel. A new kind or a new code that is not
 * worded fails here instead of on a screenshot.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { DayEvents, DayRunning } from "@/components/day/day-sections";
import { ENCOUNTER_KINDS } from "@/components/encounters/encounter-labels";
import {
  DAY_EVENT_KINDS,
  DAY_RUNNING_KINDS,
  LIFE_EVENT_CATEGORIES,
  TIMELINE_ITEM_KINDS,
  type DayEvent,
  type DayRunningItem,
  type TimelineItem,
  type TimelineResponse,
} from "@/lib/day/contract";
import { I18nProvider } from "@/lib/i18n/context";
import { MOOD_ENUM_VALUES } from "@/lib/mood/labels";
import { INBOUND_DOCUMENT_KINDS } from "@/lib/validations/inbound-documents";

import { SelectionBar } from "../selection-bar";
import type { SeriesValueFormat } from "../series-format";
import { PointMark, SpanMark, TimelineChart } from "../timeline-chart";
import { TimelineChronicle } from "../timeline-chronicle";
import { layoutTimeline } from "../timeline-geometry";
import { useSeriesValueFormat } from "../use-series-value-format";
import { TODAY, item, wordsIn } from "./timeline-fixture";

type Locale = "de" | "en";

function render(node: React.ReactElement, locale: Locale) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale={locale}>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

/**
 * The text a reader sees: every character outside a tag, with a space where
 * a tag stood, so two runs ("Ereignis 0" and "FAMILY") never fuse into one
 * word the code pattern would step over.
 */
function textOf(html: string): string {
  let out = "";
  let inTag = false;
  for (const ch of html) {
    if (ch === "<") inTag = true;
    else if (ch === ">") {
      inTag = false;
      out += " ";
    } else if (!inTag) out += ch;
  }
  return out;
}

/**
 * A code as the server sends it: four or more capitals, digits or
 * underscores in one word (`FAMILY`, `SUPER_GUT`, `PHQ9`), or one of the
 * lower-case sentinels.
 */
const RAW_CODE = /\b[A-Z][A-Z0-9_]{3,}\b|\btravel\b|\bcycle\b/g;

function rawCodes(text: string): string[] {
  return [...new Set(text.match(RAW_CODE) ?? [])];
}

function WithFormat({
  build,
}: {
  build: (format: SeriesValueFormat) => React.ReactNode;
}) {
  return <>{build(useSeriesValueFormat())}</>;
}

/** Every day of September 2026, one per item, so one month holds them all. */
let nextDay = 1;
const day = () => `2026-09-${String(nextDay++).padStart(2, "0")}`;

/** Every timeline item kind, with every code its second line can carry. */
function everyKind(): TimelineResponse {
  nextDay = 1;
  const life: TimelineItem[] = [
    ...LIFE_EVENT_CATEGORIES.map((category, i) =>
      item({
        id: `le-${i}`,
        kind: "lifeEvent",
        start: day(),
        label: `Ereignis ${i}`,
        sub: category,
      }),
    ),
    item({
      id: "trip",
      kind: "travel",
      start: "2026-09-02",
      end: "2026-09-09",
      label: "travel",
    }),
  ];
  const visits: TimelineItem[] = ENCOUNTER_KINDS.map((kind, i) =>
    item({
      id: `visit-${i}`,
      kind: kind === "PROCEDURE" ? "procedure" : "visit",
      start: day(),
      // Every other visit has neither a reason nor a practitioner.
      label: i % 2 === 0 ? "" : `Termin ${i}`,
      sub: kind,
    }),
  );
  const documents: TimelineItem[] = INBOUND_DOCUMENT_KINDS.map((kind, i) =>
    item({
      id: `doc-${i}`,
      kind: "document",
      start: day(),
      label: `Brief ${i}`,
      sub: kind,
    }),
  );
  const timeline: TimelineResponse = {
    zoom: "quarter",
    range: { from: "2026-08-01", to: "2026-10-31", dataFrom: "2026-08-01" },
    bucket: "month",
    lanes: [
      { key: "life", items: life },
      {
        key: "illness",
        items: [
          item({
            id: "chronic",
            kind: "chronic",
            start: "2026-09-01",
            open: true,
            label: "Bluthochdruck",
          }),
          item({
            id: "episode",
            kind: "episode",
            start: "2026-09-03",
            end: "2026-09-12",
            label: "Erkältung",
          }),
        ],
      },
      {
        key: "allergies",
        items: [
          item({
            id: "allergy",
            kind: "allergy",
            start: "2026-09-04",
            open: true,
            label: "Penicillin",
          }),
        ],
      },
      {
        key: "medications",
        items: [
          item({
            id: "med",
            kind: "medication",
            start: "2026-09-01",
            open: true,
            label: "Ramipril",
            sub: "5 mg",
          }),
          item({
            id: "course",
            kind: "course",
            start: "2026-09-05",
            end: "2026-09-25",
            label: "Vitamin D",
          }),
          item({
            id: "dose",
            kind: "doseChange",
            start: "2026-09-10",
            label: "Ramipril",
            sub: "10 mg",
          }),
          item({
            id: "pause",
            kind: "pause",
            start: "2026-09-14",
            end: "2026-09-24",
            label: "Ramipril",
          }),
        ],
      },
      {
        key: "vaccinations",
        items: [
          item({
            id: "vacc",
            kind: "vaccination",
            start: day(),
            label: "Tetanus",
          }),
        ],
      },
      { key: "visits", items: visits },
      {
        key: "labs",
        items: [
          item({
            id: "lab-day",
            kind: "labDay",
            start: day(),
            label: "Kreatinin, Kalium, Natrium",
            sub: "5",
          }),
        ],
      },
      { key: "documents", items: documents },
      {
        key: "cycle",
        items: [
          item({
            id: "cyc",
            kind: "cycle",
            start: "2026-09-06",
            end: "2026-09-10",
            label: "cycle",
          }),
        ],
      },
    ],
    standing: [],
    series: [],
    notable: [],
  };
  // The fixture itself must reach every kind, or the guard proves less.
  const kinds = new Set(
    timeline.lanes.flatMap((l) => l.items.map((i) => i.kind)),
  );
  expect([...kinds].sort()).toEqual([...TIMELINE_ITEM_KINDS].sort());
  return timeline;
}

const SELECTED = "2026-09-15";
const noop = () => undefined;

describe.each<Locale>(["de", "en"])("the timeline in %s", (locale) => {
  it("words every code in the chronicle", () => {
    const text = textOf(
      render(
        <WithFormat
          build={(format) => (
            <TimelineChronicle
              timeline={everyKind()}
              today={TODAY}
              grouping="month"
              selected={SELECTED}
              seriesColor={() => "var(--chart-1)"}
              seriesFormat={format}
              onOpenDay={noop}
              onEditLifeEvent={null}
            />
          )}
        />,
        locale,
      ),
    );
    expect(rawCodes(text)).toEqual([]);
  });

  it("words every code in the selection bar", () => {
    const text = textOf(
      render(
        <WithFormat
          build={(format) => (
            <SelectionBar
              timeline={everyKind()}
              selected={SELECTED}
              today={TODAY}
              seriesLabel={(key) => key}
              seriesColor={() => "var(--chart-1)"}
              seriesFormat={format}
              onOpenDay={noop}
            />
          )}
        />,
        locale,
      ),
    );
    expect(text).toContain(locale === "de" ? "5 Laborwerte" : "5 lab values");
    expect(rawCodes(text)).toEqual([]);
  });

  it("words every code in the screen-reader table", () => {
    const html = render(
      <WithFormat
        build={(format) => (
          <TimelineChart
            timeline={everyKind()}
            window={{ from: "2026-08-01", to: "2026-10-31" }}
            zoom="quarter"
            today={TODAY}
            selected={null}
            hiddenLanes={new Set()}
            seriesLabel={(key) => key}
            seriesColor={() => "var(--chart-1)"}
            seriesFormat={format}
            onSelect={noop}
            onOpenDay={noop}
          />
        )}
      />,
      locale,
    );
    const table = html.slice(html.indexOf('data-slot="timeline-table"'));
    expect(rawCodes(textOf(table))).toEqual([]);
  });

  it("words every code in the lane labels and their hover titles", () => {
    const layout = layoutTimeline({
      width: 4000,
      window: { from: "2026-08-01", to: "2026-10-31" },
      lanes: everyKind().lanes,
      series: [],
      bucket: "month",
      words: wordsIn(locale),
      startMissing: "",
      today: TODAY,
    });
    const labels = layout.lanes.flatMap((l) => l.labels.map((x) => x.text));
    expect(labels.length).toBeGreaterThan(10);
    expect(rawCodes(labels.join("\n"))).toEqual([]);

    const titles = textOf(
      render(
        <svg>
          {layout.lanes.flatMap((lane) => [
            ...lane.spans.map((span) => (
              <SpanMark
                key={span.item.id}
                span={span}
                color="var(--chart-1)"
                x0={0}
                intl={locale}
                t={(key) => key}
              />
            )),
            ...lane.points.map((point) => (
              <PointMark
                key={point.item.id}
                point={point}
                color="var(--chart-1)"
                intl={locale}
              />
            )),
          ])}
        </svg>,
        locale,
      ),
    );
    // The stub `t` above leaves the range words as keys; only the item
    // words are under test here.
    expect(rawCodes(titles.replace(/timeline\.selection\.\w+/g, ""))).toEqual(
      [],
    );
  });
});

/* ─── The day view ──────────────────────────────────────────────────────── */

function event(
  kind: DayEvent["kind"],
  id: string,
  title: string,
  meta: string | null,
): DayEvent {
  return {
    at: null,
    kind,
    section: "medications",
    id,
    title,
    meta,
    note: null,
    docs: [],
    href: null,
  };
}

/** Every event kind, with every code its title or second line can carry. */
function everyEvent(): DayEvent[] {
  const out: DayEvent[] = [
    event("intake", "i", "Ramipril", "5 mg"),
    event("doseChange", "dc", "Ramipril", "10 mg"),
    event("medicationStart", "ms", "Ramipril", "5 mg"),
    event("medicationEnd", "me", "Ramipril", "5 mg"),
    event("pauseStart", "ps", "Ramipril", null),
    event("pauseEnd", "pe", "Ramipril", null),
    event("courseStart", "cs", "Vitamin D", null),
    event("courseEnd", "ce", "Vitamin D", null),
    event("illnessOnset", "io", "Erkältung", null),
    event("illnessResolved", "ir", "Erkältung", null),
    event("illnessDayLog", "idl", "Erkältung", "2"),
    event("symptom", "sy", "Kopfschmerz", "7"),
    event("allergyOnset", "ao-1", "Penicillin", "SEVERE"),
    event("allergyOnset", "ao-2", "Pollen", "MILD"),
    event("labResult", "lr", "Kreatinin", "1.1 mg/dL"),
    event("visit", "planned", "Kontrolle", "PLANNED"),
    event("vaccination", "va", "Tetanus", "2"),
    event("checkup", "ch", "Hautkrebs-Screening", null),
    event("assessment", "as-1", "PHQ9", "12 moderate"),
    event("assessment", "as-2", "GAD7", "3 minimal"),
    event("assessment", "as-3", "WHO5", "60 good"),
    event("assessment", "as-4", "SCI", "20 aboveThreshold"),
    event("workout", "wo", "running", "30 min"),
    event("cycleDayLog", "cdl", "cycle", "HEAVY"),
    ...ENCOUNTER_KINDS.map((kind, i) =>
      event(
        kind === "PROCEDURE" ? "procedure" : "visit",
        `visit-${i}`,
        "Hausärztin",
        kind,
      ),
    ),
    ...INBOUND_DOCUMENT_KINDS.map((kind, i) =>
      event("document", `doc-${i}`, `Brief ${i}`, kind),
    ),
    ...MOOD_ENUM_VALUES.map((mood, i) =>
      event("mood", `mood-${i}`, mood, String(i + 1)),
    ),
    ...LIFE_EVENT_CATEGORIES.map((category, i) =>
      event("lifeEvent", `le-${i}`, `Ereignis ${i}`, category),
    ),
  ];
  expect([...new Set(out.map((e) => e.kind))].sort()).toEqual(
    [...DAY_EVENT_KINDS].sort(),
  );
  return out;
}

function running(
  kind: DayRunningItem["kind"],
  title: string,
  sub: string | null,
): DayRunningItem {
  return {
    kind,
    section: "medications",
    id: `${kind}-${title}`,
    title,
    sub,
    since: "2026-09-01",
    until: null,
    dayIndex: 3,
    dayCount: null,
    href: null,
  };
}

function everyRunning(): DayRunningItem[] {
  const out: DayRunningItem[] = [
    running("medication", "Ramipril", "5 mg"),
    running("medicationCourse", "Vitamin D", null),
    running("medicationPause", "Ramipril", null),
    running("illness", "Erkältung", null),
    running("restMode", "Erholung", null),
    running("cyclePhase", "cycle", null),
    running("travel", "travel", null),
    ...LIFE_EVENT_CATEGORIES.map((category, i) =>
      running("lifeEvent", `Ereignis ${i}`, category),
    ),
  ];
  expect([...new Set(out.map((r) => r.kind))].sort()).toEqual(
    [...DAY_RUNNING_KINDS].sort(),
  );
  return out;
}

describe.each<Locale>(["de", "en"])("the day view in %s", (locale) => {
  it("words every code under What happened", () => {
    const text = textOf(render(<DayEvents events={everyEvent()} />, locale));
    expect(rawCodes(text)).toEqual([]);
    expect(text).toContain(locale === "de" ? "Super gut" : "Amazing");
  });

  it("words every code under Running that day", () => {
    const text = textOf(render(<DayRunning items={everyRunning()} />, locale));
    expect(rawCodes(text)).toEqual([]);
  });
});

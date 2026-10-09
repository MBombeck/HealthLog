/**
 * v1.42 (#613) — the timeline after the beta round:
 *
 *   - one medication is one entry on the phone and in the selection bar,
 *     with its dose in the text;
 *   - as many value lines as the record has kinds of value, drawn one row
 *     each, the five data colours repeating past the fifth;
 *   - the value picker is one compact button, "Values (n)";
 *   - choosing a range opens over the page and does not push the chart;
 *   - the legend explains the dashed stroke and the hollow point, in every
 *     language the app ships.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { TimelineResponse, TimelineSeries } from "@/lib/day/contract";
import { I18nProvider } from "@/lib/i18n/context";
import type { Locale } from "@/lib/i18n/config";

import { ZoomControl } from "../range-picker";
import { SelectionBar } from "../selection-bar";
import { SERIES_PALETTE, assignSeriesColors } from "../series-colors";
import type { SeriesValueFormat } from "../series-format";
import { SeriesLines } from "../timeline-chart";
import { TimelineChronicle } from "../timeline-chronicle";
import {
  SERIES_GAP,
  SERIES_HEIGHT,
  layoutTimeline,
} from "../timeline-geometry";
import { ValueSeriesMenu } from "../timeline-menus";
import { TimelineLegend } from "../timeline-view";
import { useSeriesValueFormat } from "../use-series-value-format";
import { item, wordsIn } from "./timeline-fixture";

const LOCALES: Locale[] = ["de", "en", "es", "fr", "it", "pl", "ko"];

function render(node: React.ReactElement, locale: Locale = "en") {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale={locale}>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

function text(html: string): string {
  let out = "";
  let inTag = false;
  for (const ch of html) {
    if (ch === "<") inTag = true;
    else if (ch === ">") inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}

function WithFormat({
  build,
}: {
  build: (format: SeriesValueFormat) => React.ReactNode;
}) {
  return <>{build(useSeriesValueFormat())}</>;
}

const TODAY = "2025-12-31";
const noop = () => undefined;

/** Two medications as the server sends them: four bars, drawn item by item. */
function twoMedications(): TimelineResponse {
  return {
    zoom: "year",
    range: { from: "2025-01-01", to: TODAY, dataFrom: "2024-02-01" },
    bucket: "month",
    lanes: [
      {
        key: "medications",
        items: [
          item({
            id: "rp",
            group: "rp",
            kind: "medication",
            start: "2024-02-01",
            open: true,
            label: "Ramipril",
            sub: "5 mg",
          }),
          item({
            id: "rp-course",
            group: "rp",
            kind: "course",
            start: "2025-02-01",
            end: "2025-05-31",
            label: "Ramipril",
          }),
          item({
            id: "mj",
            group: "mj",
            kind: "medication",
            start: "2025-01-06",
            open: true,
            label: "Mounjaro",
            sub: "7.5 mg",
          }),
          item({
            id: "mj-course",
            group: "mj",
            kind: "course",
            start: "2025-01-06",
            open: true,
            label: "Mounjaro",
          }),
          item({
            id: "mj-25",
            group: "mj",
            kind: "doseChange",
            start: "2025-01-06",
            label: "Mounjaro",
            sub: "2.5 mg",
          }),
          item({
            id: "mj-5",
            group: "mj",
            kind: "doseChange",
            start: "2025-03-03",
            label: "Mounjaro",
            sub: "5 mg",
          }),
          item({
            id: "mj-pause",
            group: "mj",
            kind: "pause",
            start: "2025-08-01",
            end: "2025-08-20",
            label: "Mounjaro",
          }),
        ],
      },
    ],
    standing: [],
    series: [],
    availableSeries: [],
    notable: [],
  };
}

describe("one medication, one entry", () => {
  it("lays two medications on two rows, not four", () => {
    const layout = layoutTimeline({
      width: 1200,
      window: { from: "2025-01-01", to: TODAY },
      lanes: twoMedications().lanes,
      series: [],
      bucket: "month",
      words: wordsIn("en"),
      startMissing: "start unknown",
      today: TODAY,
    });
    const lane = layout.lanes[0];
    expect(lane.rows).toBe(2);
    expect(new Set(lane.spans.map((s) => s.row))).toEqual(new Set([0, 1]));
    const names = lane.labels.map((l) => l.text);
    expect(names.filter((n) => n.startsWith("Mounjaro "))).toEqual([
      "Mounjaro 2.5 mg",
      "Mounjaro paused",
    ]);
    expect(names).toContain("5 mg");
  });

  it("names a medication once in the selection bar, with its dose", () => {
    const html = render(
      <WithFormat
        build={(format) => (
          <SelectionBar
            timeline={twoMedications()}
            selected="2025-03-10"
            today={TODAY}
            seriesLabel={(key) => key}
            seriesColor={() => "var(--chart-1)"}
            seriesFormat={format}
            onOpenDay={noop}
          />
        )}
      />,
    );
    const chips = [
      ...html.matchAll(
        /data-slot="timeline-selection-chip"[^>]*>(.*?)<\/button>/g,
      ),
    ].map((m) => text(m[1]));
    expect(chips.filter((c) => c.startsWith("Mounjaro"))).toHaveLength(1);
    expect(chips.find((c) => c.startsWith("Mounjaro"))).toMatch(
      /^Mounjaro 5 mg, since \S/,
    );
    // Ramipril's course runs through March, closed: its own days, once.
    expect(chips.filter((c) => c.startsWith("Ramipril"))).toHaveLength(1);
    expect(text(html)).not.toMatch(/ongoing/i);
  });

  it("lists a medication's start once on the phone, with the dose taken then", () => {
    const html = text(
      render(
        <WithFormat
          build={(format) => (
            <TimelineChronicle
              timeline={twoMedications()}
              today={TODAY}
              grouping="month"
              selected={null}
              seriesColor={() => "var(--chart-1)"}
              seriesFormat={format}
              onOpenDay={noop}
              onEditLifeEvent={null}
            />
          )}
        />,
      ),
    );
    // One "Mounjaro" chip in the running block, one start row with its
    // first dose, the next dose as its own row, the pause and its end.
    expect(html.match(/Mounjaro2\.5 mg/g)).toHaveLength(1);
    expect(html.match(/Mounjaro5 mg/g)).toHaveLength(1);
    expect(html).toContain("Mounjaro paused");
    expect(html).toContain("Mounjaro resumed");
    expect(html).not.toContain("7.5 mg");
  });
});

/** Fifteen value lines, a point a month for a year. */
function fifteenSeries(): TimelineSeries[] {
  const keys = [
    "BLOOD_PRESSURE_SYS",
    "BLOOD_PRESSURE_DIA",
    "WEIGHT",
    "RESTING_HEART_RATE",
    "PULSE",
    "SLEEP_DURATION",
    "BLOOD_GLUCOSE",
    "BODY_FAT",
    "HEART_RATE_VARIABILITY",
    "ACTIVITY_STEPS",
    "MOOD",
    "BODY_TEMPERATURE",
    "VO2_MAX",
    "OXYGEN_SATURATION",
    "RESPIRATORY_RATE",
  ];
  return keys.map((key, i) => ({
    key,
    unit: null,
    points: Array.from({ length: 12 }, (_, m) => ({
      t: `2025-${String(m + 1).padStart(2, "0")}-01`,
      mean: 50 + i + m,
      count: 5,
    })),
  }));
}

describe("no cap on value lines", () => {
  it("lays out fifteen lines, one row each, the chart growing downwards", () => {
    const series = fifteenSeries();
    const started = performance.now();
    const layout = layoutTimeline({
      width: 1200,
      window: { from: "2025-01-01", to: TODAY },
      lanes: twoMedications().lanes,
      series,
      bucket: "month",
      words: wordsIn("en"),
      startMissing: "start unknown",
      today: TODAY,
    });
    const took = performance.now() - started;
    expect(layout.series).toHaveLength(15);
    expect(layout.series.every((s) => s.points.length === 12)).toBe(true);
    const lanesBottom = layout.lanes.at(-1)!.top + layout.lanes.at(-1)!.height;
    expect(layout.seriesTop).toBe(lanesBottom + SERIES_GAP);
    expect(layout.height).toBe(layout.seriesTop + 15 * SERIES_HEIGHT + 4);
    // Rows never overlap.
    for (let i = 1; i < layout.series.length; i++) {
      expect(layout.series[i].top).toBe(
        layout.series[i - 1].top + SERIES_HEIGHT,
      );
    }
    // Generous for a slow runner; the layout is arithmetic over 180 points.
    expect(took).toBeLessThan(250);
  });

  it("draws every line, each named, the five data colours repeating", () => {
    const series = fifteenSeries();
    const colours = assignSeriesColors(series.map((s) => s.key));
    const layout = layoutTimeline({
      width: 1200,
      window: { from: "2025-01-01", to: TODAY },
      lanes: [],
      series,
      bucket: "month",
      words: wordsIn("en"),
      startMissing: "",
      today: TODAY,
    });
    const html = render(
      <WithFormat
        build={(format) => (
          <svg>
            <SeriesLines
              layout={layout}
              width={1200}
              selectedBucket={null}
              bucket="month"
              seriesLabel={(key) => `Line ${key}`}
              seriesColor={(key) => colours.get(key)!}
              intl="en-GB"
              t={(key) => key}
              fmt={format}
            />
          </svg>
        )}
      />,
    );
    const drawn = [
      ...html.matchAll(/data-series="([A-Z0-9_]+)" data-color="([^"]+)"/g),
    ];
    expect(drawn).toHaveLength(15);
    for (const [, , colour] of drawn) {
      expect(SERIES_PALETTE).toContain(colour);
    }
    expect(html).not.toContain('var(--foreground)" color');
    for (const s of series) expect(text(html)).toContain(`Line ${s.key}`);
  });
});

describe("the value picker", () => {
  it("is one button that counts the chosen lines and lists none of them", () => {
    const chosen = fifteenSeries().map((s) => s.key);
    for (const locale of LOCALES) {
      const html = render(
        <ValueSeriesMenu
          options={chosen}
          selected={chosen}
          label={(key) => `Name of ${key}`}
          color={() => "var(--chart-1)"}
          onChange={noop}
        />,
        locale,
      );
      expect(html).toContain('data-slot="timeline-values-trigger"');
      expect(html).toContain('data-count="15"');
      expect(text(html)).toContain("(15)");
      expect(text(html)).not.toContain("Name of");
      expect(text(html)).not.toMatch(/timeline\./);
    }
  });
});

describe("choosing a range", () => {
  it("keeps the fields out of the page until the range segment opens them", () => {
    const html = render(
      <ZoomControl
        options={[
          { value: "all", label: "All" },
          { value: "year", label: "12 months" },
          { value: "quarter", label: "3 months" },
          { value: "range", label: "Range" },
        ]}
        zoom="range"
        label="View range"
        initialRange={{ from: "2025-03-01", to: "2025-04-15" }}
        today={TODAY}
        dataFrom="2024-02-01"
        onZoom={noop}
        onApply={noop}
      />,
    );
    // The zoom control alone: no date fields in the flow above the chart,
    // so opening and closing them cannot move it.
    expect(html).toContain('data-slot="timeline-zoom"');
    expect(html).toContain('data-value="range"');
    expect(html).toMatch(
      /data-value="range"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-value="range"/,
    );
    expect(html).not.toContain('data-slot="timeline-range"');
    expect(html).not.toContain("timeline-range-from");
  });
});

describe("the legend", () => {
  it.each(LOCALES)(
    "explains the dashed stroke and the hollow point, each with its symbol (%s)",
    (locale) => {
      const html = render(<TimelineLegend bucket="month" hasSeries />, locale);
      for (const slot of ["timeline-legend-gap", "timeline-legend-thin"]) {
        const start = html.indexOf(`data-slot="${slot}"`);
        expect(start).toBeGreaterThan(-1);
        const entry = html.slice(start, html.indexOf("</span>", start));
        expect(entry).toContain("<svg");
        expect(text(`<x ${entry}`).trim().length).toBeGreaterThan(3);
      }
      const gap = html.slice(html.indexOf('data-slot="timeline-legend-gap"'));
      expect(gap.slice(0, gap.indexOf("</svg>"))).toContain(
        'stroke-dasharray="3 3"',
      );
      const thin = html.slice(html.indexOf('data-slot="timeline-legend-thin"'));
      expect(thin.slice(0, thin.indexOf("</svg>"))).toContain(
        'fill="var(--card)"',
      );
      expect(text(html)).not.toMatch(/timeline\./);
      expect(text(html)).not.toContain("·");
    },
  );

  it("leaves the value marks out when no line is drawn", () => {
    const html = render(<TimelineLegend bucket="month" hasSeries={false} />);
    expect(html).not.toContain("timeline-legend-gap");
    expect(html).not.toContain("timeline-legend-thin");
  });
});

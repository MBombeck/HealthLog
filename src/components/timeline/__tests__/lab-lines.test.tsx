/**
 * Lab markers on the timeline (#1299), as laid out and as rendered: a row
 * per marker under the value lines with its readings as single points, the
 * reference range behind them, a reading outside it drawn as a triangle and
 * worded as outside wherever it is written out, the report it came from,
 * the readings a unit left out named, and the menu's groups. All data
 * invented.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { TimelineLabSeries, TimelineResponse } from "@/lib/day/contract";
import { I18nProvider } from "@/lib/i18n/context";

import {
  LabExcludedNote,
  LabLines,
  LabSeriesTable,
  labReadingsIn,
} from "../lab-lines";
import { SelectionBar } from "../selection-bar";
import type { SeriesValueFormat } from "../series-format";
import { SERIES_HEIGHT } from "../series-geometry";
import { layoutTimeline } from "../timeline-geometry";
import { TimelineChronicle } from "../timeline-chronicle";
import { TimelineLegend } from "../timeline-legend";
import { labOptionGroups } from "../timeline-menus";
import { useSeriesValueFormat } from "../use-series-value-format";
import { TODAY, fullTimeline, item, wordsIn } from "./timeline-fixture";
import { primeLocales } from "@/__tests__/helpers/prime-locales";

primeLocales("de");

const FERRITIN: TimelineLabSeries = {
  key: "lab:bm-ferritin",
  biomarkerId: "bm-ferritin",
  name: "Ferritin",
  panel: "Eisen",
  unit: "ng/mL",
  band: { low: 30, high: 400 },
  points: [
    {
      id: "r1",
      date: "2024-02-12",
      value: 18,
      sourceValue: null,
      rangeStatus: "below",
      referenceLow: 30,
      referenceHigh: 400,
      report: {
        id: "d1",
        title: "Befund Februar",
        href: "/documents?doc=d1",
      },
    },
    {
      id: "r2",
      date: "2025-06-01",
      value: 85,
      sourceValue: null,
      rangeStatus: "in-range",
      referenceLow: 30,
      referenceHigh: 400,
      report: null,
    },
    {
      id: "r3",
      date: "2026-03-02",
      value: 420,
      sourceValue: null,
      rangeStatus: "above",
      referenceLow: 30,
      referenceHigh: 400,
      report: null,
    },
  ],
  excluded: 0,
};

const HBA1C: TimelineLabSeries = {
  key: "lab:bm-hba1c",
  biomarkerId: "bm-hba1c",
  name: "HbA1c",
  panel: null,
  unit: "%",
  band: null,
  points: [
    {
      id: "h1",
      date: "2026-03-02",
      value: 5.4,
      sourceValue: null,
      rangeStatus: "unknown",
      referenceLow: null,
      referenceHigh: null,
      report: null,
    },
  ],
  excluded: 2,
};

const WINDOW = { from: "2024-01-01", to: "2026-06-30" };

function layout(labSeries: readonly TimelineLabSeries[]) {
  const timeline = fullTimeline();
  return layoutTimeline({
    width: 900,
    window: WINDOW,
    lanes: timeline.lanes,
    series: timeline.series,
    labSeries,
    bucket: "quarter",
    words: wordsIn("de"),
    startMissing: "?",
    today: TODAY,
  });
}

function render(node: React.ReactElement, locale: "de" | "en" = "de") {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale={locale}>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

/** The text a reader sees, runs kept apart. */
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
  return out.replace(/\s+/g, " ");
}

function WithFormat({
  build,
}: {
  build: (format: SeriesValueFormat) => React.ReactNode;
}) {
  return <>{build(useSeriesValueFormat())}</>;
}

describe("the lab rows' geometry", () => {
  it("adds a row per marker under the value lines and leaves the rest as it was", () => {
    const without = layout([]);
    const withLabs = layout([FERRITIN, HBA1C]);
    expect(withLabs.series).toEqual(without.series);
    expect(withLabs.lanes).toEqual(without.lanes);
    expect(withLabs.height - without.height).toBe(2 * SERIES_HEIGHT);
    const [ferritin, hba1c] = withLabs.labSeries;
    expect(ferritin.top).toBe(
      without.seriesTop + without.series.length * SERIES_HEIGHT + 6,
    );
    expect(hba1c.top - ferritin.top).toBe(SERIES_HEIGHT);
  });

  it("places each reading on its own day, inside the plot and inside its row", () => {
    const { labSeries, scale } = layout([FERRITIN]);
    const [row] = labSeries;
    expect(row.points.map((p) => p.id)).toEqual(["r1", "r2", "r3"]);
    for (const p of row.points) {
      expect(p.x).toBeCloseTo(scale.xMid(p.date), 5);
      expect(p.x).toBeGreaterThanOrEqual(scale.x0);
      expect(p.x).toBeLessThanOrEqual(scale.x1);
      expect(p.y).toBeGreaterThanOrEqual(row.top);
      expect(p.y).toBeLessThanOrEqual(row.top + row.height);
    }
    // Higher values sit higher; the readings are joined in time order.
    const [low, mid, high] = row.points;
    expect(low.y).toBeGreaterThan(mid.y);
    expect(mid.y).toBeGreaterThan(high.y);
    expect(row.path.match(/[ML]/g)).toEqual(["M", "L", "L"]);
    expect(row.latest?.id).toBe("r3");
  });

  it("holds the reference range in the scale and paints it behind the points", () => {
    const [row] = layout([FERRITIN]).labSeries;
    expect(row.band).not.toBeNull();
    const { top, bottom } = row.band!;
    expect(top).not.toBeNull();
    expect(bottom).not.toBeNull();
    // The in-range reading lies inside the band, the others outside it.
    const [low, mid, high] = row.points;
    expect(mid.y).toBeGreaterThan(top!);
    expect(mid.y).toBeLessThan(bottom!);
    expect(low.y).toBeGreaterThan(bottom!);
    expect(high.y).toBeLessThan(top!);
  });

  it("draws one reading as a point with no line, and an empty window as no point", () => {
    const [single] = layout([HBA1C]).labSeries;
    expect(single.points).toHaveLength(1);
    expect(single.path).toBe("");
    expect(single.band).toBeNull();
    expect(single.points[0].y).toBeCloseTo(single.top + single.height / 2, 5);
    const [empty] = layout([{ ...FERRITIN, points: [] }]).labSeries;
    expect(empty.points).toEqual([]);
    expect(empty.latest).toBeNull();
  });
});

describe("the lab rows as drawn", () => {
  function drawn(rows: readonly TimelineLabSeries[]) {
    const l = layout(rows);
    return render(
      <svg>
        <LabLines
          layout={l}
          selectedBucket="2025-04-01"
          bucket="quarter"
          seriesLabel={(key) => (key === FERRITIN.key ? "Ferritin" : "HbA1c")}
          seriesColor={() => "var(--chart-3)"}
          valueText={(value, _source, unit) => `${value} ${unit}`}
        />
      </svg>,
    );
  }

  it("marks a reading outside its range by shape, the way it left", () => {
    const html = drawn([FERRITIN]);
    expect(html).toContain('data-status="below"');
    expect(html).toContain('data-status="above"');
    // Outside the range a triangle (a path), inside it a dot.
    expect(html).toMatch(/<path d="M[^"]+Z"[^>]*data-status="below"/);
    expect(html).toMatch(/<path d="M[^"]+Z"[^>]*data-status="above"/);
    expect(html).toMatch(/<circle[^>]*data-status="in-range"/);
    // The band and its dashed edges, in the row's own colour.
    expect(html).toContain('data-slot="timeline-lab-band-fill"');
    expect(html.match(/data-slot="timeline-lab-band-edge"/g)).toHaveLength(2);
    expect(html).toContain('data-color="var(--chart-3)"');
    // The newest reading beside the name; the selected bucket's ringed.
    expect(textOf(html)).toContain("420 ng/mL");
    expect(html.match(/data-slot="timeline-series-selected"/g)).toHaveLength(1);
  });

  it("says so when the window holds no reading", () => {
    const html = drawn([{ ...FERRITIN, points: [] }]);
    expect(textOf(html)).toContain("Keine Werte in diesem Zeitraum");
    expect(html).not.toContain('data-slot="timeline-lab-mark"');
  });
});

describe("the lab readings written out", () => {
  function bar(selected: string, locale: "de" | "en" = "en") {
    const timeline: TimelineResponse = {
      ...fullTimeline(),
      bucket: "quarter",
      labSeries: [FERRITIN, HBA1C],
    };
    return render(
      <WithFormat
        build={(format) => (
          <SelectionBar
            timeline={timeline}
            selected={selected}
            today={TODAY}
            seriesLabel={(key) =>
              key === FERRITIN.key
                ? "Ferritin"
                : key === HBA1C.key
                  ? "HbA1c"
                  : key
            }
            seriesColor={() => "var(--chart-3)"}
            seriesFormat={format}
            onOpenDay={() => undefined}
          />
        )}
      />,
      locale,
    );
  }

  it("lists the bucket's readings with their day, a word outside the range and the report", () => {
    const html = bar("2024-02-20");
    const text = textOf(html);
    expect(text).toContain("Ferritin 18 ng/mL, below range, Feb 12");
    expect(html).toMatch(
      /<a[^>]*href="\/documents\?doc=d1"[^>]*>Report: Befund Februar<\/a>/,
    );
    const both = textOf(bar("2026-03-10"));
    expect(both).toContain("Ferritin 420 ng/mL, above range, Mar 2");
    // In range and without a range: the value alone.
    expect(both).toContain("HbA1c 5.4 %, Mar 2");
    expect(both).not.toContain("HbA1c 5.4 %, above");
  });

  it("words the verdict in the reader's language", () => {
    expect(textOf(bar("2024-02-20", "de"))).toContain(
      "Ferritin 18 ng/mL, unter dem Referenzbereich",
    );
  });

  it("finds the readings of a stretch on their own days", () => {
    expect(
      labReadingsIn([FERRITIN, HBA1C], "2026-03-02", "2026-03-02").map(
        (r) => r.point.id,
      ),
    ).toEqual(["r3", "h1"]);
    expect(labReadingsIn([FERRITIN], "2023-01-01", "2023-12-31")).toEqual([]);
  });

  it("rides on the phone's lab-day row, with no link inside the row's button", () => {
    const timeline: TimelineResponse = {
      ...fullTimeline(),
      bucket: "quarter",
      lanes: [
        {
          key: "labs",
          items: [
            item({
              id: "lab-day:2024-02-12",
              kind: "labDay",
              start: "2024-02-12",
              label: "Ferritin",
              sub: "1",
              href: "/labs",
            }),
          ],
        },
      ],
      standing: [],
      labSeries: [FERRITIN],
    };
    const html = render(
      <WithFormat
        build={(format) => (
          <TimelineChronicle
            timeline={timeline}
            today={TODAY}
            grouping="month"
            selected={null}
            seriesColor={() => "var(--chart-3)"}
            seriesFormat={format}
            onOpenDay={() => undefined}
            onEditLifeEvent={null}
          />
        )}
      />,
      "en",
    );
    const row = html.slice(html.indexOf('data-slot="timeline-chronicle-labs"'));
    expect(textOf(row)).toContain("Ferritin 18 ng/mL, below range");
    expect(html).not.toContain('data-slot="timeline-lab-report"');
  });

  it("names the readings a unit left out, and lists every reading for a screen reader", () => {
    const note = textOf(
      render(
        <LabExcludedNote
          labSeries={[FERRITIN, HBA1C]}
          label={(key) => (key === HBA1C.key ? "HbA1c" : "Ferritin")}
        />,
        "en",
      ),
    );
    expect(note).toContain("HbA1c: 2 values in another unit are not drawn");
    expect(note).not.toContain("Ferritin");

    const table = render(
      <LabSeriesTable
        labSeries={[FERRITIN]}
        window={WINDOW}
        label={() => "Ferritin"}
        valueText={(value, _source, unit) => `${value} ${unit}`}
        intl="en-GB"
      />,
      "en",
    );
    const rows = table.match(/<tr>/g) ?? [];
    expect(rows).toHaveLength(4);
    expect(textOf(table)).toContain(
      "18 ng/mL, below range, reference 30–400 ng/mL, Report: Befund Februar",
    );
  });

  it("explains its marks in the legend only when a lab line is drawn", () => {
    const without = render(<TimelineLegend bucket="quarter" hasSeries />);
    expect(without).not.toContain("timeline-legend-lab");
    const withLabs = textOf(
      render(
        <TimelineLegend bucket="quarter" hasSeries labSeries={[FERRITIN]} />,
        "en",
      ),
    );
    expect(withLabs).toContain("Lab value, as measured");
    expect(withLabs).toContain("Outside the reference range");
    expect(withLabs).toContain("Reference range");
  });
});

describe("the lab markers in the menu", () => {
  it("groups by the labs list's group, named groups first, in the reader's order", () => {
    const groups = labOptionGroups(
      [
        { key: "lab:c", name: "Zink", panel: null },
        { key: "lab:b", name: "Transferrin", panel: "Eisen" },
        { key: "lab:a", name: "Ferritin", panel: "Eisen" },
        { key: "lab:d", name: "Ärzte-Wert", panel: "Blutbild" },
        { key: "lab:a", name: "Ferritin", panel: "Eisen" },
      ],
      "de-DE",
    );
    expect(groups).toEqual([
      { panel: "Blutbild", keys: ["lab:d"] },
      { panel: "Eisen", keys: ["lab:a", "lab:b"] },
      { panel: null, keys: ["lab:c"] },
    ]);
  });
});

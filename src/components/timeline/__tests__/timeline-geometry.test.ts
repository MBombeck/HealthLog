/**
 * v1.42 (#613) — the timeline's geometry: window, scale, grid, rows, labels
 * and value lines. The renderer paints exactly this, so the promises the
 * chart makes (no label on top of another, nothing past the card edge, an
 * unknown start says so) are pinned here.
 */
import { describe, expect, it } from "vitest";

import {
  createScale,
  dateAtPointer,
  estimateTextWidth,
  fitText,
  gridTicks,
  itemLabel,
  itemsInPeriod,
  latestDataDate,
  layoutLane,
  layoutSeries,
  layoutTimeline,
  stepSelection,
  todayLabelFits,
  windowFor,
  wrapToWidth,
  type LaneLayout,
  type TimelineLayout,
} from "../timeline-geometry";
import { dayNumber } from "../timeline-dates";
import { TODAY, fullTimeline, item } from "./timeline-fixture";

const FMT = {
  year: (k: string) => k.slice(0, 4),
  monthShort: (k: string) => k.slice(5, 7),
  monthYear: (k: string) => `Monat ${k.slice(0, 7)}`,
};

function layoutAt(width: number): TimelineLayout {
  const tl = fullTimeline();
  return layoutTimeline({
    width,
    window: windowFor("all", TODAY, null, tl.range),
    lanes: tl.lanes,
    series: tl.series,
    bucket: tl.bucket,
    startMissing: "Startdatum fehlt",
    today: TODAY,
  });
}

/** Every label's box, by the same estimate the layout uses. */
function boxes(lane: LaneLayout) {
  return lane.labels.map((l) => ({
    ...l,
    a: l.x,
    b: l.x + estimateTextWidth(l.text),
  }));
}

describe("text fitting", () => {
  it("cuts a name to its column with an ellipsis", () => {
    expect(fitText("Arzt und Eingriffe", 200, 13)).toBe("Arzt und Eingriffe");
    const cut = fitText("Arzt und Eingriffe", 60, 13);
    expect(cut.endsWith("…")).toBe(true);
    expect(estimateTextWidth(cut, 13)).toBeLessThanOrEqual(60);
  });

  it("wraps a note onto lines that fit, or drops it when a word cannot", () => {
    expect(wrapToWidth("Noch keine Daten", 200)).toEqual(["Noch keine Daten"]);
    expect(wrapToWidth("Noch keine Daten", 70)).toEqual([
      "Noch keine",
      "Daten",
    ]);
    expect(wrapToWidth("Noch keine Daten", 20)).toEqual([]);
  });
});

describe("windowFor", () => {
  it("follows the server range at `all`", () => {
    expect(
      windowFor("all", TODAY, null, { from: "2019-01-01", to: "2026-12-31" }),
    ).toEqual({ from: "2019-01-01", to: "2026-12-31" });
  });

  it("shows twelve whole months that never run past this month", () => {
    expect(windowFor("year", TODAY, null)).toEqual({
      from: "2025-11-01",
      to: "2026-10-31",
    });
    // An older selection stays in view, with months on both sides.
    expect(windowFor("year", TODAY, "2026-01-03")).toEqual({
      from: "2025-07-01",
      to: "2026-06-30",
    });
  });

  it("shows three months around the selection at `quarter`", () => {
    expect(windowFor("quarter", TODAY, "2026-01-03")).toEqual({
      from: "2025-12-01",
      to: "2026-02-28",
    });
    expect(windowFor("quarter", TODAY, null)).toEqual({
      from: "2026-08-01",
      to: "2026-10-31",
    });
  });

  it("ignores a selection in the future", () => {
    expect(windowFor("quarter", TODAY, "2027-05-01")).toEqual(
      windowFor("quarter", TODAY, null),
    );
  });
});

describe("createScale", () => {
  const scale = createScale({ from: "2026-01-01", to: "2026-12-31" }, 100, 465);

  it("maps the window onto the drawing width, one day per step", () => {
    expect(scale.x("2026-01-01")).toBe(100);
    expect(scale.x(dayNumber("2026-12-31") + 1)).toBe(465);
    expect(scale.x("2026-01-02") - scale.x("2026-01-01")).toBeCloseTo(1, 6);
  });

  it("reads a day back from x, clamped into the window", () => {
    expect(scale.dayAt(scale.xMid("2026-03-15"))).toBe("2026-03-15");
    expect(scale.dayAt(0)).toBe("2026-01-01");
    expect(scale.dayAt(10_000)).toBe("2026-12-31");
  });
});

describe("gridTicks", () => {
  it("labels years at `all` and drops labels that would touch", () => {
    const window = { from: "2019-01-01", to: "2026-12-31" };
    const wide = gridTicks(window, "all", createScale(window, 164, 1100), FMT);
    expect(wide.filter((t) => t.label).map((t) => t.label)).toEqual([
      "2019",
      "2020",
      "2021",
      "2022",
      "2023",
      "2024",
      "2025",
      "2026",
    ]);
    const narrow = gridTicks(window, "all", createScale(window, 140, 330), FMT);
    const labelled = narrow.filter((t) => t.label);
    expect(labelled.length).toBeLessThan(8);
    for (let i = 1; i < labelled.length; i++) {
      const prevEnd =
        labelled[i - 1].x + 6 + estimateTextWidth(labelled[i - 1].label!, 12);
      expect(labelled[i].x + 6).toBeGreaterThanOrEqual(prevEnd);
    }
  });

  it("lets the axis labels win over the Today label", () => {
    const window = { from: "2019-01-01", to: "2026-12-31" };
    const scale = createScale(window, 164, 1100);
    const ticks = gridTicks(window, "all", scale, FMT);
    // Early October: clear of the 2026 label, room for "Heute".
    expect(todayLabelFits(ticks, scale.xMid("2026-10-07"), 30, 164)).toBe(true);
    // Mid January: right on top of the 2026 label.
    expect(todayLabelFits(ticks, scale.xMid("2026-01-20"), 30, 164)).toBe(
      false,
    );
  });

  it("draws months at `year` and weekly lines at `quarter`", () => {
    const year = { from: "2025-11-01", to: "2026-10-31" };
    expect(
      gridTicks(year, "year", createScale(year, 164, 1200), FMT),
    ).toHaveLength(12);
    const quarter = { from: "2025-12-01", to: "2026-02-28" };
    const ticks = gridTicks(
      quarter,
      "quarter",
      createScale(quarter, 164, 1200),
      FMT,
    );
    expect(ticks.filter((t) => t.major)).toHaveLength(3);
    expect(ticks.filter((t) => !t.major).length).toBeGreaterThanOrEqual(11);
  });
});

describe("layoutLane", () => {
  const window = { from: "2019-01-01", to: "2026-12-31" };
  const scale = createScale(window, 164, 1200);
  const opts = { startMissing: "Startdatum fehlt", today: TODAY };

  it("puts overlapping periods on separate rows and lets later ones reuse a free row", () => {
    const lane = fullTimeline().lanes.find((l) => l.key === "illness")!;
    const layout = layoutLane({ lane, top: 0 }, window, scale, opts);
    const chronic = layout.spans.find((s) => s.item.id === "ill-chronic")!;
    const episodes = layout.spans.filter((s) => s.item.kind === "episode");
    expect(chronic.row).toBe(0);
    expect(new Set(episodes.map((s) => s.row))).toEqual(new Set([1]));
    expect(layout.rows).toBe(2);
  });

  it("lays a dose change and a pause over the medication they belong to", () => {
    const lane = fullTimeline().lanes.find((l) => l.key === "medications")!;
    const layout = layoutLane({ lane, top: 0 }, window, scale, opts);
    const host = layout.spans.find((s) => s.item.id === "med-1")!;
    expect(layout.points.find((p) => p.item.id === "dose-1")?.row).toBe(
      host.row,
    );
    const pause = layout.spans.find((s) => s.item.id === "pause-1")!;
    expect(pause.pause).toBe(true);
    expect(pause.row).toBe(host.row);
  });

  it("starts an open period at its start and runs it to today", () => {
    const lane = fullTimeline().lanes.find((l) => l.key === "allergies")!;
    const layout = layoutLane({ lane, top: 0 }, window, scale, opts);
    const grass = layout.spans.find((s) => s.item.id === "al-1")!;
    expect(grass.clippedLeft).toBe(true);
    expect(grass.xStart).toBe(164);
    expect(grass.xEnd).toBeCloseTo(scale.x(dayNumber(TODAY) + 1), 6);
  });

  it("names an unknown start in the label", () => {
    const unknown = item({
      id: "m",
      kind: "medication",
      start: "2024-05-01",
      open: true,
      startKnown: false,
      label: "Ramipril",
      sub: "5 mg",
    });
    expect(itemLabel(unknown, "Startdatum fehlt")).toBe(
      "Ramipril · 5 mg · Startdatum fehlt",
    );
    const layout = layoutLane(
      { lane: { key: "medications", items: [unknown] }, top: 0 },
      window,
      scale,
      opts,
    );
    expect(layout.labels[0].text).toContain("Startdatum fehlt");
  });

  it("names life events beside their diamonds, clear of the glyph", () => {
    const lane = fullTimeline().lanes.find((l) => l.key === "life")!;
    const layout = layoutLane({ lane, top: 0 }, window, scale, opts);
    expect(layout.labels.map((l) => l.text)).toEqual([
      "Geburt Tochter",
      "Umzug",
      "Neue Stelle",
    ]);
    for (const label of layout.labels) {
      const point = layout.points.find((p) => p.item.id === label.itemId)!;
      expect(label.x).toBeGreaterThan(point.x + 7);
      expect(label.strong).toBe(true);
    }
  });

  it("puts procedures on their own row below the plain visits", () => {
    const lane = fullTimeline().lanes.find((l) => l.key === "visits")!;
    const layout = layoutLane({ lane, top: 0 }, window, scale, opts);
    expect(
      layout.points
        .filter((p) => p.item.kind === "visit")
        .every((p) => p.row === 0),
    ).toBe(true);
    expect(
      layout.points
        .filter((p) => p.item.kind === "procedure")
        .every((p) => p.row === 1),
    ).toBe(true);
    expect(layout.labels.map((l) => l.text)).toContain("Darmspiegelung");
  });
});

describe("label collision avoidance", () => {
  // 1440 full, 1440 with the docked day panel (~700), a laptop and a
  // narrow tablet column.
  for (const width of [1180, 940, 700, 520]) {
    it(`never overlaps two labels or runs past the edge at ${width} px`, () => {
      const layout = layoutAt(width);
      for (const lane of layout.lanes) {
        const list = boxes(lane);
        for (const box of list) {
          expect(box.a).toBeGreaterThanOrEqual(layout.scale.x0);
          expect(box.b).toBeLessThanOrEqual(layout.scale.x1);
        }
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const a = list[i];
            const b = list[j];
            if (a.y !== b.y) continue;
            const overlap = a.a < b.b && b.a < a.b;
            expect(overlap, `${a.text} / ${b.text}`).toBe(false);
          }
        }
      }
    });
  }

  it("never puts a label over a bar of its own row", () => {
    const layout = layoutAt(940);
    for (const lane of layout.lanes) {
      for (const label of lane.labels) {
        // Labels on a bar's line sit at y + 4; above-labels at y - 7.
        const onLine = lane.spans.filter((s) => s.y + 4 === label.y);
        for (const s of onLine) {
          const b = label.x + estimateTextWidth(label.text);
          const overlap = label.x < s.xEnd && s.xStart < b;
          expect(overlap, `${label.text} over ${s.item.label}`).toBe(false);
        }
      }
    }
  });

  it("drops labels rather than squeezing them when the panel narrows the card", () => {
    const wide = layoutAt(1180).lanes.reduce((n, l) => n + l.labels.length, 0);
    const narrow = layoutAt(520).lanes.reduce((n, l) => n + l.labels.length, 0);
    expect(narrow).toBeLessThan(wide);
    expect(narrow).toBeGreaterThan(0);
  });
});

describe("layoutTimeline", () => {
  it("leaves an empty lane out entirely", () => {
    const layout = layoutAt(1180);
    expect(layout.lanes.map((l) => l.key)).not.toContain("labs");
    expect(layout.lanes.map((l) => l.key)).toEqual([
      "life",
      "illness",
      "allergies",
      "medications",
      "vaccinations",
      "visits",
      "documents",
    ]);
  });

  it("stacks lanes without gaps and puts the value lines below", () => {
    const layout = layoutAt(1180);
    for (let i = 1; i < layout.lanes.length; i++) {
      expect(layout.lanes[i].top).toBe(
        layout.lanes[i - 1].top + layout.lanes[i - 1].height,
      );
    }
    const last = layout.lanes.at(-1)!;
    expect(layout.seriesTop).toBeGreaterThan(last.top + last.height);
    expect(layout.series).toHaveLength(3);
  });
});

describe("layoutSeries", () => {
  const window = { from: "2025-10-01", to: "2026-10-31" };
  const scale = createScale(window, 164, 1200);
  const [bp] = layoutSeries(
    fullTimeline().series.slice(0, 1),
    0,
    window,
    scale,
    "month",
  );

  it("keeps every month with a reading as a point, and invents none", () => {
    expect(bp.points.map((p) => p.t)).toEqual([
      "2025-10-01",
      "2025-11-01",
      "2025-12-01",
      "2026-01-01",
      "2026-03-01",
      "2026-07-01",
    ]);
    expect(bp.points.map((p) => p.mean)).toEqual([
      127, 128, 130, 129, 133, 131,
    ]);
    expect(bp.latest).toBe(131);
  });

  it("draws the run solid, bridges one missing month dashed, and breaks at three", () => {
    const [oct, , , jan, mar, jul] = bp.points;
    const at = (p: { x: number; y: number }) =>
      `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
    // One solid run, October to January.
    expect(bp.path.match(/M/g)).toHaveLength(1);
    expect(bp.path.startsWith(`M${at(oct)}`)).toBe(true);
    expect(bp.path.endsWith(`L${at(jan)}`)).toBe(true);
    // February is missing: one dashed stroke from January to March, with no
    // vertex between them.
    expect(bp.bridges).toBe(`M${at(jan)}L${at(mar)}`);
    // April to June are missing: July joins nothing.
    expect(bp.path).not.toContain(at(jul));
    expect(bp.bridges).not.toContain(at(jul));
  });

  it("draws a bucket of fewer than three readings hollow", () => {
    expect(bp.points.map((p) => [p.t, p.thin])).toEqual([
      ["2025-10-01", false],
      ["2025-11-01", false],
      ["2025-12-01", false],
      ["2026-01-01", false],
      ["2026-03-01", true],
      ["2026-07-01", true],
    ]);
  });

  it("bridges at most one missing quarter and four missing weeks", () => {
    const quarter = (points: Array<[string, number]>) =>
      layoutSeries(
        [
          {
            key: "WEIGHT",
            unit: "kg",
            points: points.map(([t, mean]) => ({ t, mean, count: 5 })),
          },
        ],
        0,
        { from: "2020-01-01", to: "2026-12-31" },
        createScale({ from: "2020-01-01", to: "2026-12-31" }, 164, 1200),
        "quarter",
      )[0];
    // Q1, then Q3: one missing quarter, bridged.
    expect(
      quarter([
        ["2024-01-01", 80],
        ["2024-07-01", 81],
      ]).bridges,
    ).not.toBe("");
    // Q1, then Q4: two missing quarters, broken; each point still drawn.
    const broken = quarter([
      ["2024-01-01", 80],
      ["2024-10-01", 81],
    ]);
    expect(broken.bridges).toBe("");
    expect(broken.path).toBe("");
    expect(broken.points).toHaveLength(2);

    const weeks = (second: string) =>
      layoutSeries(
        [
          {
            key: "WEIGHT",
            unit: "kg",
            points: [
              { t: "2026-01-05", mean: 80, count: 3 },
              { t: second, mean: 81, count: 3 },
            ],
          },
        ],
        0,
        { from: "2026-01-01", to: "2026-03-31" },
        createScale({ from: "2026-01-01", to: "2026-03-31" }, 164, 1200),
        "week",
      )[0];
    // Mondays: four missing weeks bridged, five broken.
    expect(weeks("2026-02-09").bridges).not.toBe("");
    expect(weeks("2026-02-16").bridges).toBe("");
  });

  it("keeps a lone point visible", () => {
    const [weight] = layoutSeries(
      fullTimeline().series.slice(2, 3),
      0,
      window,
      scale,
      "month",
    );
    expect(weight.path).toBe("");
    expect(weight.bridges).toBe("");
    expect(weight.points).toHaveLength(1);
  });

  it("keeps an empty series as a row without a line", () => {
    const early = { from: "2019-01-01", to: "2019-12-31" };
    const [empty] = layoutSeries(
      fullTimeline().series.slice(0, 1),
      0,
      early,
      createScale(early, 164, 1200),
      "month",
    );
    expect(empty.path).toBe("");
    expect(empty.points).toEqual([]);
    expect(empty.latest).toBeNull();
  });
});

describe("interaction", () => {
  it("snaps a click near a mark to the mark's date", () => {
    const layout = layoutAt(1180);
    const visits = layout.lanes.find((l) => l.key === "visits")!;
    const visit = visits.points.find((p) => p.item.id === "v-4")!;
    expect(dateAtPointer(layout, visit.x + 3, visit.y + 2)).toBe("2026-01-03");
  });

  it("falls back to the day under the pointer", () => {
    const layout = layoutAt(1180);
    const x = layout.scale.xMid("2023-06-15");
    expect(dateAtPointer(layout, x, layout.height - 2)).toBe("2023-06-15");
  });

  it("steps a day, a month or a year with the zoom, never into the future", () => {
    expect(stepSelection("2026-01-03", 1, "quarter", TODAY, "2019-01-01")).toBe(
      "2026-01-04",
    );
    expect(stepSelection("2026-01-03", -1, "year", TODAY, "2019-01-01")).toBe(
      "2025-12-03",
    );
    expect(stepSelection("2026-01-03", -1, "all", TODAY, "2019-01-01")).toBe(
      "2025-01-03",
    );
    expect(stepSelection("2026-10-01", 1, "year", TODAY, "2019-01-01")).toBe(
      TODAY,
    );
    expect(stepSelection("2019-02-01", -1, "all", TODAY, "2019-01-01")).toBe(
      "2019-01-01",
    );
  });

  it("names what happens, starts, ends or runs through the month, not the backdrop", () => {
    const entries = itemsInPeriod(
      fullTimeline().lanes,
      "2026-01-01",
      "2026-01-31",
      TODAY,
    );
    const ids = entries.map((e) => e.item.id);
    expect(ids).toEqual(["ill-5", "course-3", "v-4"]);
    // The winter course neither starts nor ends in January: it runs through.
    expect(entries.find((e) => e.item.id === "course-3")?.through).toBe(true);
    expect(entries.find((e) => e.item.id === "ill-5")?.through).toBe(false);
    // Open since 2019 and 2018: the backdrop of every month, left out.
    expect(ids).not.toContain("ill-chronic");
    expect(ids).not.toContain("al-1");
    // An open period that starts in the month is named.
    const march2019 = itemsInPeriod(
      fullTimeline().lanes,
      "2019-03-01",
      "2019-03-31",
      TODAY,
    );
    expect(march2019.map((e) => e.item.id)).toContain("ill-chronic");
  });

  it("selects the newest bucket the bar has something for, never a document-only one", () => {
    const timeline = fullTimeline();
    const all = timeline.range;
    // The newest value (July's systolic mean) beats the older entries.
    expect(latestDataDate(timeline, TODAY, all)).toBe("2026-07-01");
    // A later document does not count: the bar does not list documents,
    // so selecting its month would open on "No entries".
    const withDocument = {
      ...timeline,
      lanes: timeline.lanes.map((lane) =>
        lane.key === "documents"
          ? {
              ...lane,
              items: [
                ...lane.items,
                item({ id: "doc-late", kind: "document", start: "2026-08-20" }),
              ],
            }
          : lane,
      ),
    };
    expect(latestDataDate(withDocument, TODAY, all)).toBe("2026-07-01");
    expect(
      latestDataDate(withDocument, TODAY, {
        from: "2026-08-01",
        to: "2026-10-31",
      }),
    ).toBeNull();
    // Inside a window, a closed period running past its end counts up to
    // the window's last day, and whatever is selected the bar names it.
    const window = { from: "2025-11-01", to: "2026-01-31" };
    const day = latestDataDate(timeline, TODAY, window)!;
    expect(day).toBe("2026-01-31");
    expect(
      itemsInPeriod(timeline.lanes, "2026-01-01", "2026-01-31", TODAY).length,
    ).toBeGreaterThan(0);
  });
});

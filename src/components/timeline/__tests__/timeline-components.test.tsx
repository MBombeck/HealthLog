/**
 * v1.42 (#613) — the timeline's surfaces as rendered: the readiness
 * inventory in its three states, the card, the phone chronicle's honest
 * gaps and the selection bar's hand-off to the day, and the capture-picker
 * gate for life events.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  CAPTURE_KIND_ORDER,
  visibleCaptureKinds,
} from "@/components/layout/capture-picker";
import { I18nProvider, useTranslations } from "@/lib/i18n/context";

import { ReadinessCard } from "../readiness-card";
import { ReadinessInventory, VerdictMeter } from "../readiness-inventory";
import { SelectionBar, bucketTitle } from "../selection-bar";
import { assignSeriesColors } from "../series-colors";
import type { SeriesValueFormat } from "../series-format";
import {
  MeanPartsLine,
  SeriesLines,
  SeriesNameLinks,
  TimelineChart,
} from "../timeline-chart";
import { SeriesPointTips, tipLeft } from "../series-point-tips";
import { TimelineChronicle } from "../timeline-chronicle";
import { layoutTimeline } from "../timeline-geometry";
import { useSeriesValueFormat } from "../use-series-value-format";
import { TODAY, fullTimeline, readiness, wordsIn } from "./timeline-fixture";

function render(node: React.ReactElement, locale: "de" | "en" = "de") {
  // A fresh client with no account answer: the unit preference resolves to
  // its default (metric), as it does before `/api/auth/me` lands.
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale={locale}>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

/** Renders `build` with the timeline's real value format. */
function WithFormat({
  build,
}: {
  build: (format: SeriesValueFormat) => React.ReactNode;
}) {
  return <>{build(useSeriesValueFormat())}</>;
}

/** Runs `run` with the bundle's `t`, for the plain wording helpers. */
function I18nProbe({
  run,
}: {
  run: (t: ReturnType<typeof useTranslations>["t"]) => string;
}) {
  const { t } = useTranslations();
  return <>{run(t)}</>;
}

/**
 * The text a reader sees, without the markup between the runs. A walk over
 * the characters rather than a pattern, so a tag split across another cannot
 * survive it.
 */
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

const COLORS = assignSeriesColors([
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "WEIGHT",
]);
const seriesColor = (key: string) => COLORS.get(key) ?? "var(--foreground)";

describe("readiness inventory", () => {
  it("names every lane with its state and one link per gap", () => {
    const html = render(<ReadinessInventory readiness={readiness()} />);
    expect(html.match(/data-slot="timeline-readiness-lane"/g)).toHaveLength(6);
    expect(html).toContain('data-status="carries"');
    expect(html).toContain('data-status="thin"');
    expect(html).toContain('data-status="empty"');
    expect(html).toContain("6 Episoden, davon 1 chronisch");
    expect(html).toContain("5 Medikamente, 3 ohne Startdatum");
    expect(html).toContain("3 Messgrößen seit März 2019");
    expect(html.match(/data-slot="timeline-readiness-gap"/g)).toHaveLength(3);
    expect(html).toContain('href="/medications/med-1?edit=1"');
    expect(html).toContain("Impfpass erfassen");
  });

  it("leaves out a detail the bundle cannot word instead of showing a raw key", () => {
    const html = render(
      <ReadinessInventory
        readiness={readiness({
          lanes: [
            {
              key: "labs",
              status: "carries",
              count: 2,
              detail: { key: "somethingNew", params: { count: 2 } },
              gaps: [{ key: "unknownGap", count: 0, href: "/labs" }],
            },
          ],
        })}
      />,
    );
    expect(html).not.toContain("somethingNew");
    expect(html).not.toContain("unknownGap");
    expect(html).not.toContain('data-slot="timeline-readiness-gap"');
  });

  it("states the verdict as a count, never a score", () => {
    const carries = render(<VerdictMeter readiness={readiness()} />);
    expect(carries).toContain("Trägt schon.");
    expect(carries).toContain(
      "3 von 6 Spuren reichen für einen Überblick ab März 2019.",
    );
    expect(carries).toContain('aria-label="3 von 6 Spuren tragen"');
    const thin = render(
      <VerdictMeter readiness={readiness({ verdict: "thin", since: null })} />,
    );
    expect(thin).toContain("Noch dünn.");
    expect(thin).not.toContain("Überblick ab");
  });

  it("puts the gaps on the timeline card with their lines", () => {
    const html = render(
      <ReadinessCard readiness={readiness()} onDismiss={() => undefined} />,
    );
    expect(html).toContain("3 Medikamente ohne Startdatum");
    expect(html).toContain("Noch keine Lebensereignisse");
    expect(html).toContain('href="/timeline?add=lifeEvent"');
    expect(html).toContain('data-slot="timeline-readiness-card-dismiss"');
  });
});

describe("chronicle", () => {
  it("names an empty stretch instead of skipping it, and folds the ongoing items", () => {
    // Without the standing medication and the value lines, April to October
    // 2026 hold nothing at all.
    const full = fullTimeline();
    const eventsOnly = {
      ...full,
      series: [],
      lanes: full.lanes.map((lane) =>
        lane.key === "medications"
          ? { ...lane, items: lane.items.filter((i) => i.group !== "med-1") }
          : lane,
      ),
    };
    const html = render(
      <WithFormat
        build={(format) => (
          <TimelineChronicle
            timeline={eventsOnly}
            today={TODAY}
            grouping="month"
            selected="2026-01-03"
            seriesColor={seriesColor}
            seriesFormat={format}
            onOpenDay={() => undefined}
            onEditLifeEvent={null}
          />
        )}
      />,
    );
    expect(html).toContain("Keine Einträge von April bis Oktober 2026");
    expect(html).toContain("2 Allergien");
    expect(html).toContain("Erkältung vorbei");
    expect(html).toContain("nach 9 Tagen");
    expect(html).toContain("Höchster Wert seit Langem");
    // The selected day is the highlighted row.
    expect(html).toMatch(/data-date="2026-01-03"><button[^>]*bg-muted/);
  });

  it("never calls a month empty while a medication was taken in it", () => {
    const html = render(
      <WithFormat
        build={(format) => (
          <TimelineChronicle
            timeline={fullTimeline()}
            today={TODAY}
            grouping="month"
            selected={null}
            seriesColor={seriesColor}
            seriesFormat={format}
            onOpenDay={() => undefined}
            onEditLifeEvent={null}
          />
        )}
      />,
    );
    // April to October 2026 hold no event, but Ramipril was taken.
    expect(html).not.toContain("Keine Einträge von April bis Oktober 2026");
    expect(html).toContain("Dauerhaft");
    // Every medication entry wears the medication colour.
    for (const icon of html.match(/<svg[^>]*data-lane="medications"[^>]*>/g) ??
      []) {
      expect(icon).toContain("color:var(--chart-1)");
    }
    expect(html).toMatch(/data-lane="medications"/);
  });

  it("reads a pause as paused and resumed, never as an end", () => {
    const html = text(
      render(
        <WithFormat
          build={(format) => (
            <TimelineChronicle
              timeline={fullTimeline()}
              today={TODAY}
              grouping="month"
              selected={null}
              seriesColor={seriesColor}
              seriesFormat={format}
              onOpenDay={() => undefined}
              onEditLifeEvent={null}
            />
          )}
        />,
        "en",
      ),
    );
    expect(html).toContain("Ramipril paused");
    expect(html).toContain("Ramipril resumed");
    expect(html).toContain("after 11 days");
    expect(html).not.toContain("Ramipril ended");
  });

  it("shows the month's means beside the month", () => {
    const html = render(
      <WithFormat
        build={(format) => (
          <TimelineChronicle
            timeline={fullTimeline()}
            today={TODAY}
            grouping="month"
            selected={null}
            seriesColor={seriesColor}
            seriesFormat={format}
            onOpenDay={() => undefined}
            onEditLifeEvent={null}
          />
        )}
      />,
    );
    expect(text(html)).toContain("129/82 mmHg, 82,6 kg");
  });

  it("names a quarter once, at its newest month, with its span", () => {
    const timeline = {
      ...fullTimeline(),
      bucket: "quarter" as const,
      series: [
        {
          key: "WEIGHT",
          unit: "kg",
          points: [{ t: "2026-01-01", mean: 82.6, count: 9 }],
        },
      ],
    };
    const html = render(
      <WithFormat
        build={(format) => (
          <TimelineChronicle
            timeline={timeline}
            today={TODAY}
            grouping="month"
            selected={null}
            seriesColor={seriesColor}
            seriesFormat={format}
            onOpenDay={() => undefined}
            onEditLifeEvent={null}
          />
        )}
      />,
    );
    expect(html.match(/data-slot="timeline-chronicle-means"/g)).toHaveLength(1);
    expect(text(html)).toContain("Jan bis März 2026: 82,6 kg");
  });
});

const LABELS: Record<string, string> = {
  BLOOD_PRESSURE_SYS: "Blutdruck sys.",
  BLOOD_PRESSURE_DIA: "Blutdruck dia.",
  WEIGHT: "Gewicht",
};
const seriesLabel = (key: string) => LABELS[key] ?? key;

/** The selection bar with the real value format. */
const bar = (selected: string, timeline = fullTimeline(), showHint = false) =>
  render(
    <WithFormat
      build={(format) => (
        <SelectionBar
          timeline={timeline}
          selected={selected}
          showHint={showHint}
          today={TODAY}
          seriesLabel={seriesLabel}
          seriesColor={seriesColor}
          seriesFormat={format}
          onOpenDay={() => undefined}
        />
      )}
    />,
  );

describe("selection bar", () => {
  it("lists the month's entries, and no separate link to open the day", () => {
    const html = bar("2026-01-03");
    expect(html).toContain("Januar 2026");
    expect(html).toContain("Erkältung, 31. Dez. bis 8. Jan.");
    // A closed course that runs through the month reads its own days; no
    // "ongoing" word stands for them.
    expect(html).toContain("Vitamin D (Winter), 1. Nov. bis 31. März");
    expect(html).not.toContain("laufend");
    expect(html).not.toContain("Bluthochdruck");
    // The day opens from its chips and the chart; the lone "Open 3 Jan."
    // link at the end of the bar is gone.
    expect(html).not.toContain("3. Jan. öffnen");
    expect(html).not.toContain('data-slot="timeline-open-day"');
  });

  it("names a pause as a pause", () => {
    const html = text(bar("2021-06-05"));
    expect(html).toContain("Ramipril pausiert, 1. Juni bis 11. Juni");
  });

  it("names the bucket's means, the readings behind each as a hover and for a screen reader", () => {
    const html = bar("2026-01-03");
    // What the line shows: the name and the value, nothing more.
    const visible = text(
      html.replace(
        /<span[^>]*data-slot="timeline-mean-detail"[^>]*>[^<]*<\/span>/g,
        "",
      ),
    );
    expect(visible).toContain("Ø Blutdruck 129/82 mmHg, Gewicht 82,6 kg");
    expect(visible).not.toContain("Schnitt aus");
    // The readings: a title on the value, and the same words read aloud.
    expect(html).toContain('title="Schnitt aus 4 Messungen"');
    expect(html).toContain('title="Schnitt aus 3 Messungen"');
    expect(text(html)).toContain(
      "Ø Blutdruck 129/82 mmHg, Schnitt aus 4 Messungen, Gewicht 82,6 kg, Schnitt aus 3 Messungen",
    );
    expect(text(bar("2026-07-15"))).toContain(
      "Ø Blutdruck sys. 131 mmHg, 1 Messung, Blutdruck dia. kein Wert, Gewicht kein Wert",
    );
  });

  it("says a missing month has no value instead of interpolating one", () => {
    const html = bar("2026-02-10");
    expect(text(html)).toContain(
      "Ø Blutdruck sys. kein Wert, Blutdruck dia. kein Wert, Gewicht kein Wert",
    );
    // January's 129 and March's 133 would make 131 between them.
    expect(html).not.toMatch(/\d mmHg/);
  });
});

describe("value table for a screen reader", () => {
  it("lists every month between the first and the last reading, gaps as gaps", () => {
    const html = render(
      <WithFormat
        build={(format) => (
          <TimelineChart
            timeline={fullTimeline()}
            window={{ from: "2025-10-01", to: "2026-10-31" }}
            zoom="year"
            today={TODAY}
            selected={null}
            hiddenLanes={new Set()}
            seriesLabel={seriesLabel}
            seriesColor={seriesColor}
            seriesFormat={format}
            onSelect={() => undefined}
            onOpenDay={() => undefined}
          />
        )}
      />,
    );
    const table = html.slice(html.indexOf('data-slot="timeline-series-table"'));
    // October 2025 to July 2026: ten months, newest first.
    expect(table.match(/data-bucket="/g)).toHaveLength(10);
    const row = (bucket: string) => {
      const start = table.indexOf(`data-bucket="${bucket}"`);
      return table.slice(start, table.indexOf("</tr>", start));
    };
    expect(row("2026-02-01")).toContain("Februar 2026");
    expect(row("2026-02-01").match(/kein Wert/g)).toHaveLength(3);
    expect(row("2026-01-01")).toContain("129 mmHg, Schnitt aus 4 Messungen");
    expect(row("2026-07-01")).toContain("131 mmHg, 1 Messung");
    expect(row("2026-05-01")).not.toMatch(/mmHg|kg/);
  });
});

describe("selection bar head and hint", () => {
  it("names the bucket outright, for each bucket size", () => {
    const de = (start: string, bucket: "quarter" | "month" | "week") =>
      text(
        render(
          <I18nProbe run={(t) => bucketTitle(start, bucket, "de-DE", t)} />,
        ),
      );
    expect(de("2026-07-01", "quarter")).toBe("Juli bis September 2026");
    expect(de("2026-09-01", "month")).toBe("September 2026");
    expect(de("2026-09-21", "week")).toBe("Woche vom 21. September 2026");
  });

  it("heads the bar with the selected day's bucket and lists its entries", () => {
    const quarter = { ...fullTimeline(), bucket: "quarter" as const };
    const html = bar("2026-01-03", quarter);
    expect(html).toContain('data-period-from="2026-01-01"');
    expect(html).toContain('data-period-to="2026-03-31"');
    expect(text(html)).toContain("Januar bis März 2026");
    expect(text(html)).toContain("Erkältung, 31. Dez. bis 8. Jan.");
  });

  it("calls a bucket empty only when it holds neither an entry nor a value", () => {
    // July 2026: no entry, but a systolic mean.
    expect(bar("2026-07-15")).not.toContain("timeline-selection-empty");
    // May 2026: no entry, no value.
    expect(text(bar("2026-05-10"))).toContain(
      "Keine Einträge in diesem Zeitraum",
    );
  });

  it("says how to pick a day only until one is picked", () => {
    expect(bar("2026-01-03", fullTimeline(), true)).toContain(
      'data-slot="timeline-selection-hint"',
    );
    expect(text(bar("2026-01-03", fullTimeline(), true))).toContain(
      "Klicke auf einen Zeitpunkt, um ihn hier zu sehen",
    );
    expect(bar("2026-01-03")).not.toContain("timeline-selection-hint");
  });

  it("reads sleep as a duration, not as minutes", () => {
    const timeline = {
      ...fullTimeline(),
      series: [
        {
          key: "SLEEP_DURATION",
          unit: "minutes",
          points: [{ t: "2026-01-01", mean: 556, count: 31 }],
        },
      ],
    };
    const html = text(bar("2026-01-03", timeline));
    expect(html).toContain("9 Std. 16 Min., Schnitt aus 31 Messungen");
    expect(html).not.toContain("556");
  });
});

describe("value line colours", () => {
  const layout = () =>
    layoutTimeline({
      width: 900,
      window: { from: "2025-10-01", to: "2026-10-31" },
      lanes: [],
      series: fullTimeline().series,
      bucket: "month",
      words: wordsIn(),
      startMissing: "",
      today: TODAY,
    });

  it("draws a line's swatch, path, bridge and points in one colour", () => {
    const html = render(
      <WithFormat
        build={(format) => (
          <svg>
            <SeriesLines
              layout={layout()}
              width={900}
              selectedBucket="2026-01-01"
              seriesLabel={seriesLabel}
              seriesColor={seriesColor}
              t={(key) => key}
              fmt={format}
            />
          </svg>
        )}
      />,
    );
    const group = (key: string) => {
      const start = html.indexOf(`data-series="${key}"`);
      const end = html.indexOf("</g>", start);
      return html.slice(start, end);
    };
    const colours = new Set<string>();
    for (const key of ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA", "WEIGHT"]) {
      const g = group(key);
      const colour = seriesColor(key);
      colours.add(colour);
      // The group sets the colour once; every mark inherits it.
      expect(g).toContain(`color="${colour}"`);
      expect(g).toContain('data-slot="timeline-series-swatch"');
      const strokes = [...g.matchAll(/stroke="([^"]+)"/g)].map((m) => m[1]);
      expect(strokes.length).toBeGreaterThan(0);
      expect(new Set(strokes)).toEqual(new Set(["currentColor"]));
      const fills = [...g.matchAll(/<circle[^>]*fill="([^"]+)"/g)].map(
        (m) => m[1],
      );
      for (const fill of fills) {
        expect(["currentColor", "var(--card)", "none"]).toContain(fill);
      }
    }
    // The systolic line has its bridge and its hollow point in that colour.
    expect(group("BLOOD_PRESSURE_SYS")).toContain(
      'data-slot="timeline-series-bridge"',
    );
    expect(group("BLOOD_PRESSURE_SYS")).toContain('data-thin="true"');
    // Its January point is ringed for the selection.
    expect(group("BLOOD_PRESSURE_SYS")).toContain(
      'data-slot="timeline-series-selected"',
    );
    // Three lines, three colours.
    expect(colours.size).toBe(3);
  });

  it("marks each mean with its line's colour", () => {
    const html = render(
      <MeanPartsLine
        parts={[
          { key: "BLOOD_PRESSURE_SYS", text: "129/82 mmHg" },
          { key: "WEIGHT", text: "82,6 kg" },
        ]}
        seriesColor={seriesColor}
      />,
    );
    for (const key of ["BLOOD_PRESSURE_SYS", "WEIGHT"]) {
      const part = html.slice(html.indexOf(`data-series="${key}"`));
      const dot = part.slice(part.indexOf('data-slot="timeline-series-dot"'));
      expect(dot.slice(0, dot.indexOf(">"))).toContain(
        `style="background:${seriesColor(key)}"`,
      );
    }
    // Apart by space on screen, a comma for a screen reader; never a dot.
    expect(text(html)).toBe("129/82 mmHg, 82,6 kg");
    expect(html).toContain('class="sr-only">, </span>');
  });
});

describe("life events in the capture picker", () => {
  const own = { inSharedRecord: false, canWriteDomain: () => true };
  it("is offered only with the timeline module on", () => {
    expect(
      visibleCaptureKinds(own, CAPTURE_KIND_ORDER, { timeline: false }),
    ).not.toContain("lifeEvent");
    expect(
      visibleCaptureKinds(own, CAPTURE_KIND_ORDER, { timeline: true }),
    ).toContain("lifeEvent");
  });

  it("is never offered inside somebody else's record", () => {
    const delegate = { inSharedRecord: true, canWriteDomain: () => true };
    expect(
      visibleCaptureKinds(delegate, CAPTURE_KIND_ORDER, { timeline: true }),
    ).not.toContain("lifeEvent");
  });
});

describe("value-line names", () => {
  it("lead to their metric's page, with a 44 px target, and none for a kind without one", () => {
    const tl = fullTimeline();
    const layout = layoutTimeline({
      width: 1200,
      window: { from: "2025-10-01", to: "2026-10-31" },
      lanes: tl.lanes,
      series: [...tl.series, { key: "NOT_A_TYPE", unit: null, points: [] }],
      bucket: tl.bucket,
      words: wordsIn("de"),
      startMissing: "?",
      today: TODAY,
    });
    const html = render(
      <SeriesNameLinks layout={layout} seriesLabel={(k) => `name ${k}`} />,
    );
    expect(html).toMatch(
      /data-slot="timeline-series-link"[^>]*data-series="WEIGHT"|href="\/insights\/weight"[^>]*data-slot="timeline-series-link"/,
    );
    expect(html).toContain('href="/insights/weight"');
    expect(html).toContain('href="/insights/blood-pressure"');
    expect(html).toContain('aria-label="name WEIGHT"');
    expect(html).not.toContain('data-series="NOT_A_TYPE"');
    for (const height of html.match(/height:(\d+)px/g) ?? []) {
      expect(Number(height.replace(/\D/g, ""))).toBeGreaterThanOrEqual(44);
    }
  });
});

describe("a value line's point, on its own", () => {
  const layout = () =>
    layoutTimeline({
      width: 900,
      window: { from: "2025-10-01", to: "2026-10-31" },
      lanes: [],
      series: fullTimeline().series,
      bucket: "month",
      words: wordsIn(),
      startMissing: "",
      today: TODAY,
    });

  it("gives every point a 24 px target named by its line alone, one tab stop per line", () => {
    const html = render(
      <WithFormat
        build={(format) => (
          <SeriesPointTips
            layout={layout()}
            today={TODAY}
            seriesLabel={seriesLabel}
            seriesColor={seriesColor}
            fmt={format}
            bucketLabel={(t) => `Monat ${t}`}
            onSelect={() => undefined}
            onOpenDay={() => undefined}
          />
        )}
      />,
    );
    const targets =
      html.match(/<button[^>]*data-slot="timeline-point-target"[^>]*>/g) ?? [];
    const points = layout().series.reduce((n, s) => n + s.points.length, 0);
    expect(targets).toHaveLength(points);
    for (const tag of targets) {
      expect(tag).toContain("width:24px");
      expect(tag).toContain("height:24px");
    }
    // One stop per line: the newest point of each.
    const stops = targets.filter((tag) => tag.includes('tabindex="0"'));
    expect(stops).toHaveLength(layout().series.length);
    // A point names its line, its stretch, its value and its readings, and
    // nothing of the other lines.
    const weight = targets.find((tag) => tag.includes('data-series="WEIGHT"'))!;
    expect(weight).toMatch(
      /aria-label="[^"]*Monat 2026-01-01[^"]*82,6[^"]*3 Messungen"/,
    );
    expect(weight).not.toContain("Blutdruck");
    // Nothing shows until a point is pointed at.
    expect(html).not.toContain('data-slot="timeline-point-tip"');
  });

  it("keeps the card inside the chart's width", () => {
    expect(tipLeft(450, 200, 900)).toBe(350);
    expect(tipLeft(20, 200, 900)).toBe(0);
    expect(tipLeft(890, 200, 900)).toBe(700);
  });
});

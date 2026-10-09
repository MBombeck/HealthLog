/**
 * v1.42 (#613) — the timeline's surfaces as rendered: the readiness
 * inventory in its three states, the card, the phone chronicle's honest
 * gaps and the selection bar's hand-off to the day, and the capture-picker
 * gate for life events.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CAPTURE_KIND_ORDER,
  visibleCaptureKinds,
} from "@/components/layout/capture-picker";
import { I18nProvider } from "@/lib/i18n/context";

import { ReadinessCard } from "../readiness-card";
import { ReadinessInventory, VerdictMeter } from "../readiness-inventory";
import { SelectionBar } from "../selection-bar";
import { TimelineChart } from "../timeline-chart";
import { TimelineChronicle } from "../timeline-chronicle";
import { TODAY, fullTimeline, readiness } from "./timeline-fixture";

function render(node: React.ReactElement, locale: "de" | "en" = "de") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

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
    const html = render(
      <TimelineChronicle
        timeline={fullTimeline()}
        today={TODAY}
        grouping="month"
        selected="2026-01-03"
        onOpenDay={() => undefined}
        onEditLifeEvent={null}
      />,
    );
    expect(html).toContain("April bis Oktober 2026 · keine Einträge");
    expect(html).toContain("Dauerhaft");
    expect(html).toContain("2 Allergien");
    expect(html).toContain("Erkältung vorbei");
    expect(html).toContain("nach 9 Tagen");
    expect(html).toContain("Höchster Wert seit Langem");
    // The selected day is the highlighted row.
    expect(html).toMatch(/data-date="2026-01-03"><button[^>]*bg-muted/);
  });

  it("shows the month's means beside the month", () => {
    const html = render(
      <TimelineChronicle
        timeline={fullTimeline()}
        today={TODAY}
        grouping="month"
        selected={null}
        onOpenDay={() => undefined}
        onEditLifeEvent={null}
      />,
    );
    expect(html).toContain("129/82 mmHg · 82,6 kg");
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
      <TimelineChronicle
        timeline={timeline}
        today={TODAY}
        grouping="month"
        selected={null}
        onOpenDay={() => undefined}
        onEditLifeEvent={null}
      />,
    );
    expect(html.match(/data-slot="timeline-chronicle-means"/g)).toHaveLength(1);
    expect(html).toContain("Jan bis März 2026: 82,6 kg");
  });
});

const LABELS: Record<string, string> = {
  BLOOD_PRESSURE_SYS: "Blutdruck sys.",
  BLOOD_PRESSURE_DIA: "Blutdruck dia.",
  WEIGHT: "Gewicht",
};
const seriesLabel = (key: string) => LABELS[key] ?? key;

describe("selection bar", () => {
  const bar = (selected: string) =>
    render(
      <SelectionBar
        timeline={fullTimeline()}
        selected={selected}
        today={TODAY}
        seriesLabel={seriesLabel}
        onOpenDay={() => undefined}
      />,
    );

  it("lists the month's entries and offers the selected day", () => {
    const html = bar("2026-01-03");
    expect(html).toContain("Januar 2026");
    expect(html).toContain("Erkältung · 31. Dez. bis 8. Jan.");
    expect(html).toContain("Vitamin D (Winter) · laufend");
    expect(html).not.toContain("Bluthochdruck");
    expect(html).toContain("3. Jan. öffnen");
    expect(html).toContain('data-date="2026-01-03"');
  });

  it("names the bucket's means with the readings behind each", () => {
    expect(bar("2026-01-03")).toContain(
      "Ø Januar 2026: Blutdruck 129/82 mmHg (Schnitt aus 4 Messungen) · Gewicht 82,6 kg (Schnitt aus 3 Messungen)",
    );
    expect(bar("2026-07-15")).toContain(
      "Ø Juli 2026: Blutdruck sys. 131 mmHg (1 Messung) · Blutdruck dia. kein Wert · Gewicht kein Wert",
    );
  });

  it("says a missing month has no value instead of interpolating one", () => {
    const html = bar("2026-02-10");
    expect(html).toContain(
      "Ø Februar 2026: Blutdruck sys. kein Wert · Blutdruck dia. kein Wert · Gewicht kein Wert",
    );
    // January's 129 and March's 133 would make 131 between them.
    expect(html).not.toMatch(/\d mmHg/);
  });
});

describe("value table for a screen reader", () => {
  it("lists every month between the first and the last reading, gaps as gaps", () => {
    const html = render(
      <TimelineChart
        timeline={fullTimeline()}
        window={{ from: "2025-10-01", to: "2026-10-31" }}
        zoom="year"
        today={TODAY}
        selected={null}
        hiddenLanes={new Set()}
        seriesLabel={seriesLabel}
        onSelect={() => undefined}
        onOpenDay={() => undefined}
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

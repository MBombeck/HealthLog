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
});

describe("selection bar", () => {
  it("lists the month's entries and offers the selected day", () => {
    const html = render(
      <SelectionBar
        timeline={fullTimeline()}
        selected="2026-01-03"
        today={TODAY}
        onOpenDay={() => undefined}
      />,
    );
    expect(html).toContain("Januar 2026");
    expect(html).toContain("Erkältung · 31. Dez. bis 8. Jan.");
    expect(html).toContain("Vitamin D (Winter) · laufend");
    expect(html).not.toContain("Bluthochdruck");
    expect(html).toContain("3. Jan. öffnen");
    expect(html).toContain('data-date="2026-01-03"');
    expect(html).toContain("Ø 129/82 mmHg · 82,6 kg");
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

/**
 * The rail under its group headings (#1113): headings expanded, a hairline
 * and a screen-reader heading collapsed, a count only above zero and named in
 * the link, no heading over an empty group, and no entry lost on the way.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  NAV_DESTINATIONS,
  groupNavDestinations,
  visibleNavDestinations,
} from "@/components/layout/nav-model";
import { RailNavGroups } from "@/components/layout/rail-nav-groups";
import { TooltipProvider } from "@/components/ui/tooltip";
import { checkupsDueCount, dosesDueCount } from "@/hooks/use-nav-counts";
import { I18nProvider } from "@/lib/i18n/context";

function render(
  items: typeof NAV_DESTINATIONS,
  collapsed: boolean,
  counts: Record<string, number> = {},
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <TooltipProvider>
        <RailNavGroups
          items={items}
          pathname="/medications"
          collapsed={collapsed}
          counts={counts}
          medsIntent={{
            onPointerEnter: () => {},
            onTouchStart: () => {},
            onFocus: () => {},
          }}
        />
      </TooltipProvider>
    </I18nProvider>,
  );
}

describe("RailNavGroups", () => {
  it("draws three headings over the entries, Dashboard alone on top", () => {
    const html = render(NAV_DESTINATIONS, false);
    const headings = [
      ...html.matchAll(/data-slot="nav-group-heading"[^>]*>([^<]+)</g),
    ].map((m) => m[1]);
    expect(headings).toEqual(["Tracking", "Health record", "Analysis"]);
    expect(html.indexOf(">Dashboard<")).toBeLessThan(html.indexOf("Tracking"));
    // Headings are labels, never controls.
    expect(html).not.toMatch(/<button[^>]*>Tracking/);
  });

  it("keeps the group names for screen readers when collapsed", () => {
    const html = render(NAV_DESTINATIONS, true);
    expect(html).toContain('class="sr-only"');
    expect(html).toMatch(/role="group" aria-labelledby="[^"]+-record"/);
    expect(html).toContain('aria-label="Checkups"');
  });

  it("shows a count only above zero, and names it", () => {
    const html = render(NAV_DESTINATIONS, false, {
      "/medications": 2,
      "/checkups": 0,
    });
    expect(html.match(/data-slot="nav-count"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Medications, 2 due"');
  });

  it("leaves a fully switched-off group without its heading", () => {
    const html = render(
      NAV_DESTINATIONS.filter((d) => d.group !== "analysis"),
      false,
    );
    expect(html).not.toContain(">Analysis<");
  });

  it("loses no entry to the grouping", () => {
    for (const modules of [{}, { mood: false, timeline: false, labs: false }]) {
      const visible = visibleNavDestinations(modules);
      const grouped = groupNavDestinations(visible).flatMap((g) => g.items);
      expect(grouped.map((d) => d.href).sort()).toEqual(
        visible.map((d) => d.href).sort(),
      );
    }
  });
});

describe("the counts", () => {
  it("counts doses due or overdue, nothing answered", () => {
    expect(
      dosesDueCount([
        { state: "due" },
        { state: "overdue" },
        { state: "upcoming" },
        { state: "taken" },
        { state: "skipped" },
        { state: null },
      ]),
    ).toBe(2);
    expect(dosesDueCount(undefined)).toBe(0);
  });

  it("counts check-ups due today or overdue, not paused or snoozed", () => {
    const now = Date.parse("2026-11-22T10:00:00Z");
    const row = (
      nextDueAt: string | null,
      extra: Partial<{ enabled: boolean; snoozedUntil: string | null }> = {},
    ) => ({ enabled: true, snoozedUntil: null, nextDueAt, ...extra });
    expect(
      checkupsDueCount(
        [
          row("2026-11-22T08:00:00Z"),
          row("2026-11-10T08:00:00Z"),
          row("2026-11-30T08:00:00Z"),
          row(null),
          row("2026-11-22T08:00:00Z", { enabled: false }),
          row("2026-11-22T08:00:00Z", {
            snoozedUntil: "2026-11-23T08:00:00Z",
          }),
        ],
        now,
        "Europe/Berlin",
      ),
    ).toBe(2);
  });
});

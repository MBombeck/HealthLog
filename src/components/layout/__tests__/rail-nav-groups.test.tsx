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
import { navCountsByHref } from "@/hooks/use-nav-counts";
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
    expect(html).toContain('aria-label="Care"');
  });

  it("shows a count only above zero, and names it", () => {
    const html = render(NAV_DESTINATIONS, false, {
      "/medications": 2,
      "/care": 0,
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
  it("maps the server's counts onto the two entries", () => {
    expect(navCountsByHref({ dosesDue: 2, checkupsDue: 1 })).toEqual({
      "/medications": 2,
      "/care": 1,
    });
    expect(navCountsByHref(undefined)).toEqual({});
  });
});

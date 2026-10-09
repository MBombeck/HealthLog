import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CalendarDays } from "lucide-react";

import { stripDayOf } from "@/components/day/day-url";
import {
  dayYields,
  listYields,
  BOTH_PANELS_QUERY,
} from "@/components/insights/coach-panel/conversations-panel";

import { DOCK_SLIDE, DockStrip } from "../shell-dock";

/**
 * The docked panels' strips (v1.42). Each docked panel keeps its own strip
 * at the right edge; the strip is a toggle for its panel, never moves, and
 * below 1600 px only one panel is open. The click paths, focus and the
 * geometry run in `e2e/dock-strips.spec.ts`.
 */
function strip(expanded: boolean) {
  return renderToStaticMarkup(
    <DockStrip
      slot="day-strip"
      order={2}
      controls="day-docked-panel"
      expanded={expanded}
      label="Thu, 4 Jun 2026"
      actionLabel={expanded ? "Hide day" : "Show Thursday, 4 June 2026"}
      icon={CalendarDays}
      onToggle={() => {}}
      data={{ "data-day": "2026-06-04" }}
    />,
  );
}

describe("DockStrip", () => {
  it("is a toggle button for its panel, closed", () => {
    const html = strip(false);
    expect(html).toContain('data-slot="day-strip"');
    expect(html).toContain('data-state="closed"');
    expect(html).toContain('data-day="2026-06-04"');
    expect(html).toMatch(/<button[^>]*type="button"/);
    expect(html).toContain('data-slot="day-strip-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="day-docked-panel"');
    expect(html).toContain('aria-label="Show Thursday, 4 June 2026"');
    // The label reads top to bottom.
    expect(html).toContain("[writing-mode:vertical-rl]");
    expect(html).toContain("Thu, 4 Jun 2026");
  });

  it("says it is open and what a click does then", () => {
    const html = strip(true);
    expect(html).toContain('data-state="open"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-label="Hide day"');
  });

  it("keeps the same shape open and closed, below the top bar's band", () => {
    const shape = (html: string) => html.match(/^<div[^>]*class="([^"]*)"/)![1];
    expect(shape(strip(true))).toBe(shape(strip(false)));
    expect(shape(strip(false))).toContain("w-10");
    // The first cell is the band (`SHELL_HEADER_BAND`), empty and hidden.
    expect(strip(false)).toMatch(
      /^<div[^>]*><div aria-hidden="true" class="h-16 border-b/,
    );
  });

  it("orders the strips like their panels: conversations, then the day", () => {
    const list = renderToStaticMarkup(
      <DockStrip
        slot="coach-panel-strip"
        order={1}
        controls="coach-conversations-panel"
        expanded={false}
        label="Conversations"
        actionLabel="Show conversations"
        icon={CalendarDays}
        onToggle={() => {}}
      />,
    );
    expect(list).toMatch(/^<div[^>]*class="[^"]*\border-1\b/);
    expect(strip(false)).toMatch(/^<div[^>]*class="[^"]*\border-2\b/);
  });

  it("slides by width, with no motion under reduced motion", () => {
    expect(DOCK_SLIDE).toContain("transition-[width]");
    expect(DOCK_SLIDE).toContain("duration-200");
    expect(DOCK_SLIDE).toContain("motion-reduce:transition-none");
    expect(DOCK_SLIDE).toContain("overflow-hidden");
  });
});

describe("one panel open below 1600 px", () => {
  it("closes the day when the list opens below 1600 px", () => {
    expect(dayYields({ fitsBoth: false, dayOpen: true })).toBe(true);
  });

  it("keeps the day open beside the list from 1600 px", () => {
    expect(dayYields({ fitsBoth: true, dayOpen: true })).toBe(false);
  });

  it("has nothing to close without an open day", () => {
    expect(dayYields({ fitsBoth: false, dayOpen: false })).toBe(false);
  });

  it("closes the list when a day opens below 1600 px, and not from 1600 px", () => {
    const base = {
      docked: true,
      listOpen: true,
      dayOpen: true,
      dayOpened: true,
      narrowed: false,
    };
    expect(listYields({ ...base, fitsBoth: false })).toBe(true);
    expect(listYields({ ...base, fitsBoth: true })).toBe(false);
    expect(BOTH_PANELS_QUERY).toBe("(min-width: 1600px)");
  });
});

describe("the day strip's day", () => {
  const today = "2026-06-04";

  it("is the open day while one is open", () => {
    expect(stripDayOf("2026-05-30", "2026-05-01", today)).toBe("2026-05-30");
  });

  it("is the remembered day while the day is shut, across pages", () => {
    expect(stripDayOf(null, "2026-05-01", today)).toBe("2026-05-01");
  });

  it("is today when nothing is remembered, or the memory is not a day to open", () => {
    expect(stripDayOf(null, null, today)).toBe(today);
    expect(stripDayOf(null, "2999-01-01", today)).toBe(today);
    expect(stripDayOf(null, "garbage", today)).toBe(today);
  });
});

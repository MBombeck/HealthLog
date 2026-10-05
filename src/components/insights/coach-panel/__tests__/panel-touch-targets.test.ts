import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PANEL_HEADER_BUTTON } from "../conversations-panel";

/**
 * The conversations panel's controls shrink below the 44 px touch floor only
 * beside a fine pointer. A width breakpoint (`sm:` / `md:`) cannot tell a
 * tablet from a laptop: a touch tablet at 1280 px docks the panel and got
 * 28 px header buttons and 36 px rows from one.
 */
const FILES = [
  "conversations-panel.tsx",
  "history-rail.tsx",
  "coach-settings-overlay.tsx",
].map((name) => ({
  name,
  source: readFileSync(
    join(process.cwd(), "src/components/insights/coach-panel", name),
    "utf8",
  ),
}));

/** A control size set by a width breakpoint: `md:size-7`, `sm:min-h-9`. */
const WIDTH_SIZED = /\b(?:sm|md|lg|xl):(?:size|min-h|h)-(?:\d|\[)/g;

describe("conversations panel touch targets", () => {
  it.each(FILES)("$name sizes no control by viewport width", ({ source }) => {
    expect(source.match(WIDTH_SIZED) ?? []).toEqual([]);
  });

  it.each(FILES)(
    "$name shrinks its controls only beside a fine pointer",
    ({ source }) => {
      expect(source).toMatch(/pointer-fine:(?:size|min-h)-\d/);
    },
  );

  it("keeps the header buttons at 44 px and 28 px only with a fine pointer", () => {
    const classes = PANEL_HEADER_BUTTON.split(/\s+/);
    expect(classes).toContain("size-11");
    expect(classes).toContain("pointer-fine:size-7");
  });
});

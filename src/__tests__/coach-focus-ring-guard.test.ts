/**
 * Structural guard on keyboard focus in the Coach panel.
 *
 * The purple `--ring` is gone from every Coach control: a tap draws nothing,
 * keyboard focus draws a solid ring in the neutral text-field focus tone
 * (`--input-focus`). Two checks:
 *
 *   1. No class string under `coach-panel/` names the purple ring, border or
 *      outline on focus. The sweep must find a floor of neutral focus rings,
 *      so a matcher that stops matching fails instead of passing on nothing.
 *   2. The controls built on the `Button` primitive inside an answer (the
 *      reply pills, Undo, Change) pass `COACH_FOCUS_RING`, which replaces the
 *      primitive's purple ring when the classes merge.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "..", "components", "insights", "coach-panel");

const SOURCES = readdirSync(DIR)
  .filter((name) => /\.(tsx|ts)$/.test(name))
  .map((name) => ({ name, text: readFileSync(join(DIR, name), "utf8") }));

const PURPLE_FOCUS =
  /(?:focus|focus-visible|focus-within):(?:ring-ring|border-ring|outline-ring|ring-primary|border-primary)\b/g;

describe("Coach focus ring", () => {
  it("never names the purple ring on focus", () => {
    const offenders = SOURCES.flatMap(({ name, text }) =>
      [...text.matchAll(PURPLE_FOCUS)].map((m) => `${name}: ${m[0]}`),
    );
    expect(offenders).toEqual([]);
  });

  it("finds the neutral ring where it expects it", () => {
    const neutral = SOURCES.reduce(
      (n, { text }) =>
        n + (text.match(/focus-visible:ring-input-focus\b/g)?.length ?? 0),
      0,
    );
    expect(neutral).toBeGreaterThanOrEqual(15);
  });

  it.each(["suggested-replies.tsx", "memory-note.tsx", "assumption-line.tsx"])(
    "%s merges the neutral ring over the Button primitive",
    (file) => {
      const text = SOURCES.find((s) => s.name === file)?.text ?? "";
      expect(text).toMatch(
        /import \{ COACH_FOCUS_RING \} from "\.\/focus-ring"/,
      );
      expect(text).toMatch(/cn\([\s\S]*?COACH_FOCUS_RING,?\s*\)/);
    },
  );
});

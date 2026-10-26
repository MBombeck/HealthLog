/**
 * Segmented is the one segmented control in the tree. Its behaviour (roving
 * focus, toggle mode, disabled, the chosen segment's fill) is driven in a real
 * browser by `segmented.browser.test.tsx`; this file holds the source sweeps
 * that keep a second control from appearing beside it.
 */
import { describe, expect, it } from "vitest";

describe("one segmented control", () => {
  it("is the only segmented-control component in the tree", async () => {
    const { join } = await import("node:path");
    const { readSourceText, walkSourceFiles } =
      await import("@/__tests__/helpers/source-files");
    const src = join(__dirname, "../../..");
    const defining = walkSourceFiles(src, { floor: 2000 })
      .filter((p) => !p.includes("__tests__/"))
      .filter((p) =>
        /export function (?:Segmented\w*|ViewToggle|\w*SegmentedToggle)\b/.test(
          readSourceText(join(src, p)),
        ),
      );
    expect(defining).toEqual(["components/ui/segmented.tsx"]);
  });
});

/**
 * A row of buttons whose `aria-pressed` compares a state to each button's
 * value is a segmented control spelled by hand: six of them sat beside
 * `Segmented` (the narrative period, the lab result type, both admin filters,
 * the chart range tabs, the mood chart's copy of them), each with its own
 * size, fill and gap. New ones are refused; the ones that remain are not one
 * choice on one track, and say why.
 */
describe("no hand-built segmented control", () => {
  const PRESSED_BY_VALUE = /aria-pressed=\{[^}]*===[^}]*\}/g;

  const NOT_A_SEGMENT: Record<string, string> = {
    "components/settings/security-section/passkey-list-section.tsx":
      "one method is disabled while the account has no passkey; Segmented disables the whole track",
    "components/medications/units-per-dose-field.tsx":
      "a chip row that opens a free-number field for any other count",
    "components/body-sites/body-sites-section.tsx":
      "wrapping side chips under a body-site picker, not a track",
    "components/illness/log-day-sheet.tsx":
      "a graded severity scale per symptom, one square per level",
    "components/cycle/log-day-sheet.tsx":
      "a graded severity scale per symptom, one circle per level",
    "components/charts/chart-overlay-controls.tsx":
      "baselines stay pressable while greyed, with a tooltip saying why there is no data",
    "components/timeline/timeline-view.tsx":
      "a single button that opens the range sheet, beside the zoom Segmented",
  };

  function pressedByValue(source: string): number {
    return (source.match(PRESSED_BY_VALUE) ?? []).length;
  }

  it("finds none outside the reasoned exceptions", async () => {
    const { join } = await import("node:path");
    const { readSourceText, stripComments, walkSourceFiles } =
      await import("@/__tests__/helpers/source-files");
    const src = join(__dirname, "../../..");
    const found = walkSourceFiles(src, { floor: 2000 })
      .filter((p) => /^(components|app)\//.test(p))
      .filter((p) => !p.includes("__tests__/"))
      .filter((p) => p !== "components/ui/segmented.tsx")
      .filter(
        (p) => pressedByValue(stripComments(readSourceText(join(src, p)))) > 0,
      )
      .sort();
    expect(found).toEqual(Object.keys(NOT_A_SEGMENT).sort());
  });

  it("counter-check: catches a hand-built pair, not an on/off toggle", () => {
    expect(
      pressedByValue(`<Button aria-pressed={filter === "all"}>All</Button>
<Button aria-pressed={filter === "failed"}>Failed</Button>`),
    ).toBe(2);
    expect(pressedByValue(`<Button aria-pressed={open}>Show</Button>`)).toBe(0);
  });
});

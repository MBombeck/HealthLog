/**
 * `<DateField>` contract (v1.25.11 — app-controlled calendar).
 *
 * The native `<input type="date">` picker is gone: the date field now opens a
 * shadcn `<Calendar>` (react-day-picker) inside a `<Popover>`, so the picker
 * renders identically on every browser / OS. The popover content only mounts
 * once the popover is open, so under the SSR-only convention (no
 * `@testing-library/react`, `environment: "node"`, `renderToStaticMarkup`) the
 * calendar itself isn't in the static markup — the same way the old picker /
 * typed-entry paths could never be driven here. What the static markup CAN pin
 * is the load-bearing contract:
 *
 *   - the committed VALUE stays ISO `yyyy-MM-dd` on a hidden mirror input
 *     carrying `name`, so this is a drop-in for `<DateInput>` and react-hook-
 *     form is unchanged;
 *   - the visible overlay paints the value formatted per the preference;
 *   - disabled / placeholder thread through;
 *   - height + target-size parity classes are present;
 *   - the calendar popover trigger is exposed as a labelled affordance.
 *
 * Under SSR `useDateFormatPreference()` resolves AUTO (no `window`), so the
 * overlay reflects the locale order — de → dd.MM.yyyy, en → MM/dd/yyyy. The
 * per-preference order itself is covered exhaustively in
 * `src/lib/__tests__/date-format.test.ts` against the pure formatter; the
 * min/max bounds (calendar matcher + ISO clamp) ride the interactive picker
 * and are not observable in the static markup.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { DateField } from "../date-field";

function render(node: React.ReactNode, locale: "de" | "en" = "en"): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<DateField>", () => {
  it("keeps the ISO value on a hidden mirror input carrying the name", () => {
    const html = render(<DateField id="dob" name="dob" value="2026-02-19" />);
    // The real value lives on a hidden mirror input (the form's source of
    // truth + native-submit carrier), not a native date picker anymore.
    expect(html).toMatch(/<input[^>]*type="hidden"[^>]*value="2026-02-19"/);
    expect(html).toContain('name="dob"');
    // …and there is no native date picker in the tree.
    expect(html).not.toContain('type="date"');
  });

  it("paints the AUTO-locale display string over the value (en → MM/dd/yyyy)", () => {
    const html = render(<DateField value="2026-02-19" />, "en");
    expect(html).toContain('value="02/19/2026"');
  });

  it("paints the AUTO-locale display string over the value (de → dd.MM.yyyy)", () => {
    const html = render(<DateField value="2026-02-19" />, "de");
    expect(html).toContain('value="19.02.2026"');
  });

  it("renders the placeholder shape when empty", () => {
    const html = render(<DateField value="" placeholder="Pick a date" />);
    expect(html).toContain('placeholder="Pick a date"');
  });

  it("derives a format-shaped placeholder when none is supplied (en → MM/DD/YYYY)", () => {
    const html = render(<DateField value="" />, "en");
    expect(html).toContain('placeholder="MM/DD/YYYY"');
  });

  it("threads disabled onto the overlay and the hidden mirror input", () => {
    const html = render(
      <DateField
        value="2026-02-19"
        disabled
        min="2020-01-01"
        max="2030-12-31"
      />,
    );
    // Both the visible overlay and the hidden mirror reflect the disabled state.
    expect(html).toMatch(/<input[^>]*type="hidden"[^>]*disabled/);
    expect(html).toMatch(/disabled/);
    // min/max are enforced by the calendar matcher + ISO clamp, not by a native
    // input attribute, so they no longer appear in the static markup.
    expect(html).not.toContain('min="2020-01-01"');
    expect(html).not.toContain('max="2030-12-31"');
  });

  it("ships the WCAG target-size + height-parity classes", () => {
    const html = render(<DateField value="2026-02-19" />);
    // Same 44px mobile / 40px sm+ floor as <DateInput>.
    expect(html).toContain("min-h-11");
    expect(html).toContain("sm:h-10");
  });

  it("gives the calendar button a 44 px touch target at its 32 px size", () => {
    const html = render(<DateField value="2026-02-19" />);
    const button = /<button[^>]*aria-label="Open date picker"[^>]*>/.exec(
      html,
    )?.[0];
    expect(button).toBeDefined();
    // Painted size unchanged; the ::before halo adds 6 px per edge.
    expect(button).toContain("h-8 w-8");
    expect(button).toContain("relative");
    expect(button).toContain("before:-inset-1.5");
    expect(button).toContain("before:absolute");
  });

  it("exposes a labelled calendar picker affordance", () => {
    const html = render(<DateField value="2026-02-19" />);
    expect(html).toContain('aria-label="Open date picker"');
  });

  it("uses the Input focus vocabulary — a neutral border, no ring", () => {
    // Drift guard: the field shares the app's text-field focus (the border
    // turns the neutral input-focus tone, no ring), so the highlight never
    // paints wider than the div or jumps on focus.
    const html = render(<DateField value="2026-02-19" />);
    expect(html).toContain("focus-within:border-input-focus");
    expect(html).not.toMatch(/focus-within:ring-/);
    expect(html).not.toContain("ring-offset-2");
    expect(html).not.toContain("ring-offset-background");
  });
});

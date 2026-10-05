/**
 * `<TimeField>` contract (v1.25.4).
 *
 * The app-controlled time input replaces the native `<input type="time">` so
 * the hour cycle follows the user's preference, never the browser UI language.
 * The committed VALUE is always a 24-hour `"HH:mm"` string (drop-in for the
 * native input). These tests pin the pure conversion/parse helpers plus the
 * SSR-rendered display/affordance contract.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  TimeField,
  parseHhmm,
  parseTypedTime,
  formatHhmm,
  to12hHour,
  from12hHour,
  prefersTwelveHour,
} from "../time-field";

function render(node: React.ReactNode, locale: "de" | "en" = "en"): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("parseHhmm", () => {
  it("splits a well-formed 24h string", () => {
    expect(parseHhmm("14:05")).toEqual({ hour: 14, minute: 5 });
    expect(parseHhmm("00:00")).toEqual({ hour: 0, minute: 0 });
    expect(parseHhmm("23:59")).toEqual({ hour: 23, minute: 59 });
  });
  it("rejects malformed / out-of-range input", () => {
    expect(parseHhmm("")).toBeNull();
    expect(parseHhmm("24:00")).toBeNull();
    expect(parseHhmm("12:60")).toBeNull();
    expect(parseHhmm("9:5")).toBeNull();
  });
});

describe("parseTypedTime", () => {
  it("accepts colon, dot and bare-digit forms", () => {
    expect(parseTypedTime("14:30")).toBe("14:30");
    expect(parseTypedTime("14.30")).toBe("14:30");
    expect(parseTypedTime("1430")).toBe("14:30");
    expect(parseTypedTime("930")).toBe("09:30");
    expect(parseTypedTime("9")).toBe("09:00");
  });
  it("honours an AM/PM affix", () => {
    expect(parseTypedTime("2:30 pm")).toBe("14:30");
    expect(parseTypedTime("2:30pm")).toBe("14:30");
    expect(parseTypedTime("12:00 am")).toBe("00:00");
    expect(parseTypedTime("12:00 pm")).toBe("12:00");
    expect(parseTypedTime("11:15 pm")).toBe("23:15");
  });
  it("rejects impossible times", () => {
    expect(parseTypedTime("")).toBeNull();
    expect(parseTypedTime("25:00")).toBeNull();
    expect(parseTypedTime("14:70")).toBeNull();
    expect(parseTypedTime("13:00 pm")).toBeNull(); // 13 can't be a 12h hour
  });
});

describe("12h <-> 24h conversion", () => {
  it("maps 24h to its 12h clock cell", () => {
    expect(to12hHour(0)).toBe(12);
    expect(to12hHour(12)).toBe(12);
    expect(to12hHour(13)).toBe(1);
    expect(to12hHour(23)).toBe(11);
  });
  it("maps a 12h cell + period back to 24h", () => {
    expect(from12hHour(12, false)).toBe(0); // 12 AM
    expect(from12hHour(12, true)).toBe(12); // 12 PM
    expect(from12hHour(1, true)).toBe(13); // 1 PM
    expect(from12hHour(11, true)).toBe(23); // 11 PM
  });
});

describe("prefersTwelveHour", () => {
  it("follows the explicit preference", () => {
    expect(prefersTwelveHour("H12", "de")).toBe(true);
    expect(prefersTwelveHour("H24", "en")).toBe(false);
  });
  it("falls to the locale under AUTO (en → 12h, others → 24h)", () => {
    expect(prefersTwelveHour("AUTO", "en")).toBe(true);
    expect(prefersTwelveHour("AUTO", "de")).toBe(false);
  });
});

describe("formatHhmm", () => {
  it("renders 24h under H24 regardless of locale", () => {
    expect(formatHhmm("14:05", "H24", "en")).toMatch(/^14:05$/);
    expect(formatHhmm("14:05", "H24", "de")).toMatch(/^14:05$/);
  });
  it("renders AM/PM under H12", () => {
    expect(formatHhmm("14:05", "H12", "de")).toMatch(/02:05\s?PM/);
  });
  it("returns empty string for malformed input", () => {
    expect(formatHhmm("", "H24", "de")).toBe("");
    expect(formatHhmm("nope", "H24", "de")).toBe("");
  });
});

describe("<TimeField> SSR", () => {
  it("gives the clock button a 44 px touch target at its 32 px size", () => {
    const html = render(<TimeField value="14:05" />, "de");
    const button = /<button[^>]*data-slot="time-field-trigger"[^>]*>/.exec(
      html,
    )?.[0];
    expect(button).toBeDefined();
    expect(button).toContain("h-8 w-8");
    expect(button).toContain("relative");
    expect(button).toContain("before:-inset-1.5");
    expect(button).toContain("before:absolute");
  });

  it("paints the value in 24h under the de AUTO locale and exposes the picker affordance", () => {
    const html = render(<TimeField value="14:05" />, "de");
    expect(html).toContain('value="14:05"');
    expect(html).toContain('data-slot="time-field-trigger"');
  });
  it("keeps the 24h value on a hidden mirror carrying name", () => {
    const html = render(<TimeField id="t" name="t" value="08:30" />, "de");
    expect(html).toMatch(/<input[^>]*type="hidden"[^>]*value="08:30"/);
    expect(html).toContain('name="t"');
  });
  it("ships the height-parity classes", () => {
    const html = render(<TimeField value="08:30" />, "de");
    expect(html).toContain("min-h-11");
    expect(html).toContain("sm:h-10");
  });
  it("uses the Input focus vocabulary — a neutral border, no ring", () => {
    // Drift guard shared with <DateField>: neutral border, no ring, so the
    // highlight never overflows the div or jumps on focus.
    const html = render(<TimeField value="08:30" />, "de");
    expect(html).toContain("focus-within:border-input-focus");
    expect(html).not.toMatch(/focus-within:ring-/);
    expect(html).not.toContain("ring-offset-2");
    expect(html).not.toContain("ring-offset-background");
  });
});

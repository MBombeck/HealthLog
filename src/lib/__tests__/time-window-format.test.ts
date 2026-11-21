import { describe, expect, test } from "vitest";

import {
  formatTimeWindowPart,
  formatTimeWindowRange,
} from "@/lib/time-window-format";

describe("formatTimeWindowPart", () => {
  test("zero-pads single-digit hours", () => {
    expect(formatTimeWindowPart("8:00")).toBe("08:00");
  });

  test("preserves two-digit hours", () => {
    expect(formatTimeWindowPart("19:30")).toBe("19:30");
  });

  test("returns input unchanged when not a HH:MM string", () => {
    expect(formatTimeWindowPart("invalid")).toBe("invalid");
  });
});

describe("formatTimeWindowRange", () => {
  test("German locale renders 'bis ... Uhr' (default behaviour preserved)", () => {
    expect(formatTimeWindowRange("19:00", "23:00", "de")).toBe(
      "19:00 bis 23:00 Uhr",
    );
  });

  test("English locale renders 'from ... to ...' instead of mixed-language 'bis Uhr'", () => {
    // Regression for v1.4.19 F-01: app rendered "Today, 19:00 bis 23:00 Uhr"
    // for English users because the formatter hard-coded German.
    expect(formatTimeWindowRange("19:00", "23:00", "en")).toBe("19:00 – 23:00");
  });

  test("falls back to the German format when no locale is supplied", () => {
    // Backwards-compat: existing call sites that have not been migrated
    // continue to render the historic German string.
    expect(formatTimeWindowRange("08:00", "12:00")).toBe("08:00 bis 12:00 Uhr");
  });

  test("collapses an equal start/end to a single time (German keeps 'Uhr')", () => {
    // BUG 1: a single target time (or a zero-span window) must not render the
    // degenerate "07:00 bis 07:00 Uhr" range — the "bis" separator is reserved
    // for a genuine range.
    expect(formatTimeWindowRange("07:00", "07:00", "de")).toBe("07:00 Uhr");
  });

  test("collapses an equal start/end to a single time (English, no 'to')", () => {
    expect(formatTimeWindowRange("07:00", "07:00", "en")).toBe("07:00");
  });

  test("collapses an equal start/end after zero-padding normalisation", () => {
    // "7:00" and "07:00" are the same clock time once normalised.
    expect(formatTimeWindowRange("7:00", "07:00", "de")).toBe("07:00 Uhr");
  });

  test("collapses an equal start/end with no locale (German fallback)", () => {
    expect(formatTimeWindowRange("07:00", "07:00")).toBe("07:00 Uhr");
  });
});

describe("formatTimeWindowRange follows the hour-cycle preference", () => {
  // A schedule time and an instant beside it must share one clock: before
  // this the window read "08:00" next to "08:30 AM".
  test("renders a 12 h reader's window in 12 h, without the German Uhr", async () => {
    const { makeFormatters } = await import("@/lib/format-locale");
    const h12 = makeFormatters("en", "Europe/Berlin", "H12", "AUTO");
    expect(h12.wallTime("08:00")).toBe("08:00 AM");
    expect(h12.wallTime("20:30")).toBe("08:30 PM");
    expect(formatTimeWindowRange("08:00", "20:00", "en", h12.wallTime)).toBe(
      "08:00 AM – 08:00 PM",
    );
    const deH12 = makeFormatters("de", "Europe/Berlin", "H12", "AUTO");
    expect(
      formatTimeWindowRange("08:00", "20:00", "de", deH12.wallTime),
    ).not.toContain("Uhr");
  });

  test("renders a 24 h reader's window in 24 h, also in an English locale", async () => {
    const { makeFormatters } = await import("@/lib/format-locale");
    const h24 = makeFormatters("en", "Europe/Berlin", "H24", "AUTO");
    expect(h24.wallTime("20:30")).toBe("20:30");
    expect(formatTimeWindowRange("08:00", "20:00", "en", h24.wallTime)).toBe(
      "08:00 – 20:00",
    );
    const de = makeFormatters("de", "Europe/Berlin", "AUTO", "AUTO");
    expect(formatTimeWindowRange("08:00", "20:00", "de", de.wallTime)).toBe(
      "08:00 bis 20:00 Uhr",
    );
  });

  test("leaves a value that is not HH:mm unchanged", async () => {
    const { makeFormatters } = await import("@/lib/format-locale");
    const fmt = makeFormatters("en", "Europe/Berlin", "H12", "AUTO");
    expect(fmt.wallTime("soon")).toBe("soon");
    expect(fmt.wallTime("25:00")).toBe("25:00");
  });
});

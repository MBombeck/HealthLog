import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  hourCycleOptions,
  makeFormatters,
  parseLocaleFromAcceptLanguage,
  resolveIntlLocale,
} from "../format-locale";

describe("resolveIntlLocale", () => {
  it("maps short locales to BCP-47 tags", () => {
    expect(resolveIntlLocale("de")).toBe("de-DE");
    expect(resolveIntlLocale("en")).toBe("en-US");
  });
});

describe("parseLocaleFromAcceptLanguage", () => {
  it("returns en for null / empty", () => {
    expect(parseLocaleFromAcceptLanguage(null)).toBe("en");
    expect(parseLocaleFromAcceptLanguage("")).toBe("en");
  });

  it("returns de for primary German tag", () => {
    expect(parseLocaleFromAcceptLanguage("de-DE,en;q=0.9")).toBe("de");
    expect(parseLocaleFromAcceptLanguage("de")).toBe("de");
    expect(parseLocaleFromAcceptLanguage("de-CH")).toBe("de");
  });

  it("returns en for English or unrecognised locales", () => {
    expect(parseLocaleFromAcceptLanguage("en-US,en;q=0.9")).toBe("en");
    expect(parseLocaleFromAcceptLanguage("ja-JP")).toBe("en");
    expect(parseLocaleFromAcceptLanguage("*")).toBe("en");
  });

  // v1.4.25 W9e — the four AI-initial locales added in this release.
  // Each maps via the same primary-tag prefix match the DE branch uses.
  it("returns the matching tag for FR / ES / IT / PL", () => {
    expect(parseLocaleFromAcceptLanguage("fr-FR,fr;q=0.9")).toBe("fr");
    expect(parseLocaleFromAcceptLanguage("es-ES")).toBe("es");
    expect(parseLocaleFromAcceptLanguage("es-MX")).toBe("es");
    expect(parseLocaleFromAcceptLanguage("it-IT")).toBe("it");
    expect(parseLocaleFromAcceptLanguage("pl-PL")).toBe("pl");
    expect(parseLocaleFromAcceptLanguage("pl")).toBe("pl");
  });
});

describe("makeFormatters", () => {
  const deFmt = makeFormatters("de", undefined, "AUTO", "AUTO");
  const enFmt = makeFormatters("en", undefined, "AUTO", "AUTO");
  const sample = new Date("2026-04-18T14:30:00Z"); // 16:30 Europe/Berlin (CEST)

  it("formats numbers with regional decimal separators", () => {
    expect(deFmt.number(70.5, 1)).toMatch(/70,5/);
    expect(enFmt.number(70.5, 1)).toMatch(/70\.5/);
  });

  it("formats integers with thousands separators", () => {
    expect(deFmt.integer(1234567)).toMatch(/1[.\u202f]234[.\u202f]567/);
    expect(enFmt.integer(1234567)).toBe("1,234,567");
  });

  it("formats percent", () => {
    expect(deFmt.percent(0.835, 1)).toMatch(/83,5\s*%/);
    expect(enFmt.percent(0.835, 1)).toMatch(/83\.5%/);
  });

  it("formats date in Europe/Berlin", () => {
    // Both should include day/month/year; locale-specific order differs.
    expect(deFmt.date(sample)).toContain("2026");
    expect(enFmt.date(sample)).toContain("2026");
  });

  // v1.15.20 — the hour cycle follows the locale convention by default
  // (AUTO). Pre-v1.15.20 both locales were pinned to 24h via `hour12:
  // false`; the explicit preference replaced the pin.
  it("formats time per the locale convention under AUTO", () => {
    expect(deFmt.time(sample)).toBe("16:30");
    expect(enFmt.time(sample)).toBe("04:30 PM");
  });

  describe("hour-cycle preference (v1.15.20)", () => {
    it("AUTO follows the locale default for time + dateTime", () => {
      const de = makeFormatters("de", undefined, "AUTO", "AUTO");
      const en = makeFormatters("en", undefined, "AUTO", "AUTO");
      expect(de.time(sample)).toBe("16:30");
      expect(en.time(sample)).toBe("04:30 PM");
      expect(de.dateTime(sample)).toBe("18.04.2026, 16:30");
      expect(en.dateTime(sample)).toBe("04/18/2026, 04:30 PM");
    });

    it("H12 forces AM/PM regardless of locale", () => {
      const de = makeFormatters("de", undefined, "H12", "AUTO");
      const en = makeFormatters("en", undefined, "H12", "AUTO");
      expect(de.time(sample)).toContain("PM");
      expect(en.time(sample)).toBe("04:30 PM");
      expect(de.dateTime(sample)).toContain("PM");
    });

    it("H24 forces the 24-hour clock regardless of locale", () => {
      const de = makeFormatters("de", undefined, "H24", "AUTO");
      const en = makeFormatters("en", undefined, "H24", "AUTO");
      expect(de.time(sample)).toBe("16:30");
      expect(en.time(sample)).toBe("16:30");
      expect(en.dateTime(sample)).toBe("04/18/2026, 16:30");
    });

    it("H24 renders midnight as 00, never 24 (h23 cycle)", () => {
      const midnight = new Date("2026-04-18T22:30:00Z"); // 00:30 Berlin CEST
      const en = makeFormatters("en", undefined, "H24", "AUTO");
      expect(en.time(midnight)).toBe("00:30");
    });

    it("does not affect date-only formatters", () => {
      const auto = makeFormatters("en", undefined, "AUTO", "AUTO");
      const h24 = makeFormatters("en", undefined, "H24", "AUTO");
      expect(auto.date(sample)).toBe(h24.date(sample));
      expect(auto.dateShort(sample)).toBe(h24.dateShort(sample));
    });
  });

  // v1.4.25 W7 — formatters accept a per-user timezone override.
  it("renders time in the user's tz when userTz is passed", () => {
    const tokyo = makeFormatters("en", "Asia/Tokyo", "H24", "AUTO");
    // 14:30 UTC = 23:30 Tokyo
    expect(tokyo.time(sample)).toBe("23:30");
  });

  it("renders time in Europe/Berlin when userTz is empty", () => {
    const fallback = makeFormatters("en", "", "H24", "AUTO");
    expect(fallback.time(sample)).toBe("16:30");
  });

  it("renders date in the user's tz when userTz is passed", () => {
    // 23:30 UTC on May 10 = 01:30 May 11 Tokyo
    const lateUtc = new Date("2026-05-10T23:30:00Z");
    const tokyo = makeFormatters("en", "Asia/Tokyo", "AUTO", "AUTO");
    expect(tokyo.date(lateUtc)).toMatch(/2026/);
    // The narrow check: day-of-month should be 11, not 10.
    expect(tokyo.date(lateUtc)).toMatch(/11/);
  });

  // ── Issue #490 — profile-timezone display matrix ──────────────────────
  //
  // The client formatters now receive the mirrored profile zone. Pin the
  // three matrix zones (east + DST, west of Berlin + DST, east no-DST)
  // and the poison values that must NEVER reach `Intl.DateTimeFormat`
  // unguarded (RangeError there would white-screen every date render).
  describe("profile-timezone matrix (#490)", () => {
    // sample = 2026-04-18T14:30:00Z (see above).
    it("renders Pacific/Auckland (UTC+12, NZST after the April DST end)", () => {
      const fmt = makeFormatters("en", "Pacific/Auckland", "H24", "AUTO");
      expect(fmt.time(sample)).toBe("02:30"); // next local day
      expect(fmt.date(sample)).toBe("04/19/2026");
    });

    it("renders America/New_York (west of Berlin, EDT)", () => {
      const fmt = makeFormatters("en", "America/New_York", "H24", "AUTO");
      expect(fmt.time(sample)).toBe("10:30");
      expect(fmt.date(sample)).toBe("04/18/2026");
    });

    it("renders Asia/Manila (UTC+8, no DST)", () => {
      const fmt = makeFormatters("en", "Asia/Manila", "H24", "AUTO");
      expect(fmt.time(sample)).toBe("22:30");
      expect(fmt.date(sample)).toBe("04/18/2026");
    });

    it.each([["Mars/Olympus"], ["garbage"], [""], [undefined]])(
      "poison zone %s never throws and falls back to Berlin",
      (zone) => {
        const fmt = makeFormatters(
          "en",
          zone as string | undefined,
          "H24",
          "AUTO",
        );
        expect(fmt.time(sample)).toBe("16:30");
        expect(fmt.date(sample)).toBe("04/18/2026");
        expect(fmt.dateTime(sample)).toBe("04/18/2026, 16:30");
        expect(fmt.dateWithWeekday(sample)).toContain("18");
        expect(fmt.monthShort(sample)).toBe("Apr");
      },
    );

    // The 23:30-Manila boundary pin: the rendered day label must equal the
    // server's profile-tz day key for the same instant — the exact split
    // #490 reported (Manila-grouped data under Berlin labels).
    it("renders the same calendar day the server day-keys (Asia/Manila)", () => {
      // YMD preference → the date renders as the ISO day key itself.
      const manila = makeFormatters("en", "Asia/Manila", "H24", "YMD");
      // 15:30 UTC = 23:30 Manila, still Jul 14 in Manila.
      const lateManilaEvening = new Date("2026-07-14T15:30:00Z");
      expect(manila.date(lateManilaEvening)).toBe("2026-07-14");
      // 17:30 UTC = 01:30 Jul 15 Manila — Berlin (19:30 Jul 14) would
      // label the previous day; the profile zone must win.
      const pastManilaMidnight = new Date("2026-07-14T17:30:00Z");
      expect(manila.date(pastManilaMidnight)).toBe("2026-07-15");
      expect(manila.time(pastManilaMidnight)).toBe("01:30");
    });

    // Berlin DST pins — the zone maths must follow the IANA rules at the
    // instant, never a cached offset.
    it("renders across the Berlin 2026-03-29 spring-forward", () => {
      const fmt = makeFormatters("de", "Europe/Berlin", "H24", "AUTO");
      // 00:30 UTC = 01:30 CET (before the 02:00→03:00 jump).
      expect(fmt.time(new Date("2026-03-29T00:30:00Z"))).toBe("01:30");
      // 01:30 UTC = 03:30 CEST (the 02:xx hour does not exist).
      expect(fmt.time(new Date("2026-03-29T01:30:00Z"))).toBe("03:30");
      expect(fmt.date(new Date("2026-03-29T01:30:00Z"))).toBe("29.03.2026");
    });

    it("renders across the Berlin 2026-10-25 fall-back (doubled hour)", () => {
      const fmt = makeFormatters("de", "Europe/Berlin", "H24", "AUTO");
      // 00:30 UTC = 02:30 CEST (first pass through the doubled hour).
      expect(fmt.time(new Date("2026-10-25T00:30:00Z"))).toBe("02:30");
      // 01:30 UTC = 02:30 CET (second pass).
      expect(fmt.time(new Date("2026-10-25T01:30:00Z"))).toBe("02:30");
      expect(fmt.date(new Date("2026-10-25T01:30:00Z"))).toBe("25.10.2026");
    });
  });

  // Issue #66 (date-format sweep) — `dateShortSmart` / `dateWithWeekdaySmart`
  // add the year only when it differs from "now"'s year, so a chart axis,
  // history list, or timeline never reads a bare "19.02." for a reading
  // from a prior year and mistakes it for this year's. "Now" is faked so
  // the boundary is deterministic regardless of the day this suite runs.
  describe("conditional-year formatters (#66)", () => {
    const RIGHT_NOW = new Date("2026-07-10T12:00:00Z");

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(RIGHT_NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("dateShortSmart omits the year for a date in the current year", () => {
      const de = makeFormatters("de", undefined, "AUTO", "AUTO");
      const en = makeFormatters("en", undefined, "AUTO", "AUTO");
      const thisYear = new Date("2026-02-19T10:00:00Z");
      expect(de.dateShortSmart(thisYear)).toBe("19.02.");
      expect(en.dateShortSmart(thisYear)).not.toContain("2026");
    });

    it("dateShortSmart includes the year for a date from a prior year", () => {
      const de = makeFormatters("de", undefined, "AUTO", "AUTO");
      const en = makeFormatters("en", undefined, "AUTO", "AUTO");
      // A December-of-last-year date — the exact regression this guards.
      const lastDecember = new Date("2025-12-16T10:00:00Z");
      expect(de.dateShortSmart(lastDecember)).toBe("16.12.2025");
      expect(en.dateShortSmart(lastDecember)).toContain("2025");
    });

    it("dateWithWeekdaySmart mirrors the same boundary", () => {
      const de = makeFormatters("de", undefined, "AUTO", "AUTO");
      const thisYear = new Date("2026-02-19T10:00:00Z");
      const lastDecember = new Date("2025-12-16T10:00:00Z");
      expect(de.dateWithWeekdaySmart(thisYear)).not.toContain("2026");
      expect(de.dateWithWeekdaySmart(lastDecember)).toContain("2025");
    });

    it("compares the year in the formatter's own timezone, not the host's", () => {
      // 2026-01-01T00:30Z is still 2025-12-31 in America/New_York (UTC-5) —
      // the profile-tz formatter must agree with what it actually prints,
      // not with a UTC or host-local read of "now"/the value.
      const nyFmt = makeFormatters("en", "America/New_York", "AUTO", "AUTO");
      const newYearUtcEve = new Date("2026-01-01T00:30:00Z");
      // RIGHT_NOW (2026-07-10) is year 2026 in New York too, so a value
      // that prints as 2025 in New York must carry the year.
      expect(nyFmt.dateShortSmart(newYearUtcEve)).toContain("2025");
    });
  });
});

// v1.25.3 — the time-format preference must reach every hour/minute renderer,
// not only the `makeFormatters().time` path. Some surfaces build their own
// `Intl.DateTimeFormat` because they render in the browser timezone (chart
// axes) or combine weekday + time in one label (workout list/detail). They now
// spread `hourCycleOptions(preference)` into the options. These tests pin both
// the helper contract and the exact call-site pattern, so a future renderer
// that drops the spread (re-introducing AM/PM under H24) fails here.
describe("hourCycleOptions", () => {
  it("AUTO contributes nothing (locale default applies)", () => {
    expect(hourCycleOptions("AUTO")).toEqual({});
  });

  it("H12 forces a 12-hour clock", () => {
    expect(hourCycleOptions("H12")).toEqual({ hour12: true });
  });

  it("H24 forces the 24-hour h23 cycle", () => {
    expect(hourCycleOptions("H24")).toEqual({ hourCycle: "h23" });
  });

  // The shared call-site shape used by sleep-hypnogram, workout-list and
  // workout-detail: an `en-US` formatter (AM/PM by default) with hour+minute.
  const sample = new Date("2026-04-18T14:30:00Z"); // 16:30 Europe/Berlin (CEST)
  const buildLabel = (preference: Parameters<typeof hourCycleOptions>[0]) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Berlin",
      hour: "2-digit",
      minute: "2-digit",
      ...hourCycleOptions(preference),
    }).format(sample);

  it("an en-US hour/minute formatter drops AM/PM under H24", () => {
    const label = buildLabel("H24");
    expect(label).not.toMatch(/[AP]M/i);
    expect(label).toBe("16:30");
  });

  it("an en-US hour/minute formatter keeps AM/PM under H12", () => {
    expect(buildLabel("H12")).toMatch(/PM/);
  });

  it("an en-US hour/minute formatter follows the locale (AM/PM) under AUTO", () => {
    expect(buildLabel("AUTO")).toMatch(/PM/);
  });
});

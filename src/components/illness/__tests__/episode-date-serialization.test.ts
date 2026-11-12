/**
 * Illness episode date serialization, timezone handling & bounded-entry validation tests.
 *
 * Covers:
 * - A date-only onset or resolved date of today used before local noon serializes
 *   to an instant that passes existing bounded-entry validation at any time of day.
 * - Non-UTC timezone simulation and host-zone execution (e.g. Asia/Tokyo, Pacific/Auckland,
 *   America/New_York) where local calendar day and UTC day differ.
 * - Edit hydration preserves the user's selected calendar date in their timezone.
 * - Historical date behavior (local noon in user's timezone) is preserved.
 * - Shared backend future-time validation remains strict (rejects future timestamps).
 * - Window order invariants (resolvedAt >= onsetAt) hold on create & update, and inverted
 *   windows are rejected.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  resolveEpisodeInstant,
  serializeEpisodeDate,
  toLocalDateKey,
} from "../dates";
import { isCalendarDateKey } from "@/lib/tz/date-only";
import {
  illnessEpisodeCreateSchema,
  illnessEpisodeUpdateSchema,
} from "@/lib/validations/illness";
import {
  isPlausibleEntryInstant,
  ENTRY_INSTANT_CLOCK_SKEW_MS,
} from "@/lib/validations/entry-instant";

describe("serializeEpisodeDate — today before local noon", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serializes today's date before local noon to a timestamp that passes bounded-entry validation", () => {
    // Current local time: 08:30:00 AM on 2026-11-10
    const now = new Date("2026-11-10T08:30:00");
    vi.setSystemTime(now);
    const today = "2026-11-10";

    const onsetAt = serializeEpisodeDate("2026-11-10", today, now);

    // Bounded-entry check with respect to system time
    expect(
      isPlausibleEntryInstant(new Date(onsetAt), { now: now.getTime() }),
    ).toBe(true);

    // Passes create schema validation
    const parsed = illnessEpisodeCreateSchema.safeParse({
      label: "Common Cold",
      type: "INFECTION",
      onsetAt,
    });
    expect(parsed.success).toBe(true);
    expect(new Date(onsetAt).getTime()).toBeLessThanOrEqual(now.getTime());
    expect(toLocalDateKey(onsetAt)).toBe("2026-11-10");
  });

  it("caps to now at any morning time of day and preserves the local calendar date", () => {
    const today = "2026-11-10";
    const earlyMorning = new Date("2026-11-10T00:05:00");
    const midMorning = new Date("2026-11-10T09:15:00");
    const lateMorning = new Date("2026-11-10T11:59:00");

    for (const now of [earlyMorning, midMorning, lateMorning]) {
      vi.setSystemTime(now);
      const onsetAt = serializeEpisodeDate(today, today, now);
      expect(new Date(onsetAt).getTime()).toBe(now.getTime());
      expect(
        isPlausibleEntryInstant(new Date(onsetAt), { now: now.getTime() }),
      ).toBe(true);
      expect(toLocalDateKey(onsetAt)).toBe(today);

      const parsed = illnessEpisodeCreateSchema.safeParse({
        label: "Cold",
        type: "INFECTION",
        onsetAt,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("demonstrates old behavior (local noon) would fail bounded-entry validation before noon", () => {
    const now = new Date("2026-11-10T08:30:00");
    vi.setSystemTime(now);
    const oldLocalNoonInstant = new Date("2026-11-10T12:00:00");

    // Local noon is 3.5 hours ahead of 08:30 AM (exceeds the 5-min skew limit)
    expect(
      isPlausibleEntryInstant(oldLocalNoonInstant, { now: now.getTime() }),
    ).toBe(false);

    // Old behavior is rejected by the backend validation
    const oldOnsetAt = oldLocalNoonInstant.toISOString();
    const parsed = illnessEpisodeCreateSchema.safeParse({
      label: "Cold",
      type: "INFECTION",
      onsetAt: oldOnsetAt,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((issue) =>
          issue.message.includes("must be a plausible instant"),
        ),
      ).toBe(true);
    }
  });
});

describe("non-UTC timezone explicit simulation & edit hydration regression", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Asia/Tokyo: morning before noon has local day ahead of UTC day; round-trips correctly", () => {
    const tz = "Asia/Tokyo";
    // 08:30 AM in Tokyo on 2026-11-10 is 2026-11-09T23:30:00.000Z in UTC
    const now = new Date("2026-11-09T23:30:00.000Z");
    vi.setSystemTime(now);
    const today = "2026-11-10";

    const onsetAt = serializeEpisodeDate(today, today, now, tz);
    expect(onsetAt).toBe("2026-11-09T23:30:00.000Z");

    // 1. Passes bounded-entry validation against the current instant
    expect(
      isPlausibleEntryInstant(new Date(onsetAt), { now: now.getTime() }),
    ).toBe(true);

    // 2. Passes backend create schema
    const createParsed = illnessEpisodeCreateSchema.safeParse({
      label: "Influenza",
      type: "INFECTION",
      onsetAt,
    });
    expect(createParsed.success).toBe(true);

    // 3. Passes backend update schema
    const updateParsed = illnessEpisodeUpdateSchema.safeParse({
      onsetAt,
    });
    expect(updateParsed.success).toBe(true);

    // 4. Edit hydration preserves selected calendar day
    expect(toLocalDateKey(onsetAt, tz)).toBe("2026-11-10");
  });

  it("Asia/Tokyo: historical date anchors to local noon (03:00 UTC) and round-trips correctly", () => {
    const tz = "Asia/Tokyo";
    const now = new Date("2026-11-09T23:30:00.000Z"); // 2026-11-10 08:30:00 JST
    vi.setSystemTime(now);
    const today = "2026-11-10";
    const historicalDate = "2026-11-05";

    const onsetAt = serializeEpisodeDate(historicalDate, today, now, tz);
    // Local noon 12:00 JST on 2026-11-05 is 03:00 UTC
    expect(onsetAt).toBe("2026-11-05T03:00:00.000Z");

    expect(
      isPlausibleEntryInstant(new Date(onsetAt), { now: now.getTime() }),
    ).toBe(true);
    expect(toLocalDateKey(onsetAt, tz)).toBe(historicalDate);

    const parsed = illnessEpisodeCreateSchema.safeParse({
      label: "Flu",
      type: "INFECTION",
      onsetAt,
    });
    expect(parsed.success).toBe(true);
  });

  it("Pacific/Auckland: UTC+13 DST historical date local noon is previous day in UTC and round-trips correctly", () => {
    const tz = "Pacific/Auckland";
    const now = new Date("2026-11-09T19:30:00.000Z"); // 2026-11-10 08:30:00 NZDT
    vi.setSystemTime(now);
    const today = "2026-11-10";
    const historicalDate = "2026-11-05";

    const onsetAt = serializeEpisodeDate(historicalDate, today, now, tz);
    // 12:00 PM NZDT (UTC+13) on 2026-11-05 is 2026-11-04T23:00:00.000Z in UTC
    expect(onsetAt).toBe("2026-11-04T23:00:00.000Z");

    expect(
      isPlausibleEntryInstant(new Date(onsetAt), { now: now.getTime() }),
    ).toBe(true);

    // Hydration correctly preserves 2026-11-05
    expect(toLocalDateKey(onsetAt, tz)).toBe("2026-11-05");
  });

  it("America/New_York: late evening (23:30) is next day in UTC; local noon anchor round-trips correctly", () => {
    const tz = "America/New_York";
    // 23:30 EST on 2026-11-10 is 2026-11-11T04:30:00.000Z in UTC
    const now = new Date("2026-11-11T04:30:00.000Z");
    vi.setSystemTime(now);
    const today = "2026-11-10";

    const onsetAt = serializeEpisodeDate(today, today, now, tz);
    // In NY, 12:00 PM EST on 2026-11-10 is 17:00 UTC (in the past relative to 23:30)
    expect(onsetAt).toBe("2026-11-10T17:00:00.000Z");

    expect(
      isPlausibleEntryInstant(new Date(onsetAt), { now: now.getTime() }),
    ).toBe(true);
    expect(toLocalDateKey(onsetAt, tz)).toBe("2026-11-10");

    const parsed = illnessEpisodeCreateSchema.safeParse({
      label: "Sprain",
      type: "INJURY",
      onsetAt,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("actual execution under non-UTC host zone (process.env.TZ)", () => {
  let previousTz: string | undefined;

  beforeAll(() => {
    previousTz = process.env.TZ;
    process.env.TZ = "Asia/Tokyo";
  });

  afterAll(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("verifies the host environment runs in Asia/Tokyo with local/UTC day divergence", () => {
    const sample = new Date("2026-11-09T23:30:00.000Z");
    // In Asia/Tokyo, 23:30 UTC is 08:30 AM on the 10th
    expect(sample.getDate()).toBe(10);
    expect(sample.getUTCDate()).toBe(9);
  });

  it("serializes and hydrates correctly in the host zone without explicit timezone argument", () => {
    const now = new Date("2026-11-09T23:30:00.000Z");
    vi.setSystemTime(now);
    const today = "2026-11-10";

    const onsetAt = serializeEpisodeDate(today, today, now);
    expect(onsetAt).toBe("2026-11-09T23:30:00.000Z");

    // Passes bounded-entry validation
    expect(
      isPlausibleEntryInstant(new Date(onsetAt), { now: now.getTime() }),
    ).toBe(true);

    // Passes schema
    const parsed = illnessEpisodeCreateSchema.safeParse({
      label: "Migraine",
      type: "OTHER",
      onsetAt,
    });
    expect(parsed.success).toBe(true);

    // Host-local hydration without passing tz still succeeds because host is in Asia/Tokyo
    expect(toLocalDateKey(onsetAt)).toBe("2026-11-10");
  });
});

describe("serializeEpisodeDate — after noon and historical dates", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves local noon anchor when used on or after local noon", () => {
    const now = new Date("2026-11-10T14:30:00");
    vi.setSystemTime(now);
    const today = "2026-11-10";

    const onsetAt = serializeEpisodeDate("2026-11-10", today, now);
    const expectedNoon = new Date("2026-11-10T12:00:00").toISOString();

    expect(onsetAt).toBe(expectedNoon);
    expect(
      isPlausibleEntryInstant(new Date(onsetAt), { now: now.getTime() }),
    ).toBe(true);
    expect(toLocalDateKey(onsetAt)).toBe("2026-11-10");

    const parsed = illnessEpisodeCreateSchema.safeParse({
      label: "Cold",
      type: "INFECTION",
      onsetAt,
    });
    expect(parsed.success).toBe(true);
  });

  it("preserves local noon anchor for historical dates", () => {
    const now = new Date("2026-11-10T08:30:00");
    vi.setSystemTime(now);
    const today = "2026-11-10";
    const historicalDate = "2026-11-05";

    const onsetAt = serializeEpisodeDate(historicalDate, today, now);
    const expectedNoon = new Date("2026-11-05T12:00:00").toISOString();

    expect(onsetAt).toBe(expectedNoon);
    expect(
      isPlausibleEntryInstant(new Date(onsetAt), { now: now.getTime() }),
    ).toBe(true);
    expect(toLocalDateKey(onsetAt)).toBe(historicalDate);

    const parsed = illnessEpisodeCreateSchema.safeParse({
      label: "Cold",
      type: "INFECTION",
      onsetAt,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("onset and resolved date window order before local noon", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts both onset and resolved as today before local noon without window inversion", () => {
    const now = new Date("2026-11-10T09:00:00");
    vi.setSystemTime(now);
    const today = "2026-11-10";

    const onsetAt = serializeEpisodeDate(today, today, now);
    const resolvedAt = serializeEpisodeDate(today, today, now);

    // Same now instant implies equal timestamps
    expect(onsetAt).toBe(resolvedAt);

    // Create schema accepts resolvedAt >= onsetAt
    const createResult = illnessEpisodeCreateSchema.safeParse({
      label: "Resolved Bout",
      type: "INFECTION",
      onsetAt,
      resolvedAt,
    });
    expect(createResult.success).toBe(true);

    // Update schema accepts resolvedAt >= onsetAt
    const updateResult = illnessEpisodeUpdateSchema.safeParse({
      onsetAt,
      resolvedAt,
    });
    expect(updateResult.success).toBe(true);
  });

  it("accepts historical onset with resolved date of today before local noon", () => {
    const now = new Date("2026-11-10T09:00:00");
    vi.setSystemTime(now);
    const today = "2026-11-10";
    const historicalOnset = "2026-11-08";

    const onsetAt = serializeEpisodeDate(historicalOnset, today, now);
    const resolvedAt = serializeEpisodeDate(today, today, now);

    // 2026-11-08T12:00:00 local is earlier than 2026-11-10T09:00:00 local
    expect(new Date(resolvedAt).getTime()).toBeGreaterThan(
      new Date(onsetAt).getTime(),
    );

    const createResult = illnessEpisodeCreateSchema.safeParse({
      label: "Recovered Flu",
      type: "INFECTION",
      onsetAt,
      resolvedAt,
    });
    expect(createResult.success).toBe(true);
  });

  it("rejects inverted window when resolvedAt precedes onsetAt", () => {
    const onsetAt = "2026-11-10T12:00:00.000Z";
    const resolvedAt = "2026-11-08T12:00:00.000Z";

    const createResult = illnessEpisodeCreateSchema.safeParse({
      label: "Inverted Episode",
      type: "INFECTION",
      onsetAt,
      resolvedAt,
    });
    expect(createResult.success).toBe(false);
    if (!createResult.success) {
      expect(
        createResult.error.issues.some((i) =>
          i.message.includes("resolvedAt must be on or after onsetAt"),
        ),
      ).toBe(true);
    }

    const updateResult = illnessEpisodeUpdateSchema.safeParse({
      onsetAt,
      resolvedAt,
    });
    expect(updateResult.success).toBe(false);
    if (!updateResult.success) {
      expect(
        updateResult.error.issues.some((i) =>
          i.message.includes("resolvedAt must be on or after onsetAt"),
        ),
      ).toBe(true);
    }
  });
});

describe("toLocalDateKey", () => {
  it("formats a local date matching the user's calendar date", () => {
    const localNoon = new Date("2026-11-10T12:00:00");
    expect(toLocalDateKey(localNoon.toISOString())).toBe("2026-11-10");
  });

  it("formats correctly with explicit timezone argument", () => {
    // 2026-11-09T23:30:00Z is 2026-11-10 in Tokyo and 2026-11-09 in New York
    const instant = "2026-11-09T23:30:00.000Z";
    expect(toLocalDateKey(instant, "Asia/Tokyo")).toBe("2026-11-10");
    expect(toLocalDateKey(instant, "America/New_York")).toBe("2026-11-09");
  });

  it("falls back to slice(0, 10) on malformed date string", () => {
    expect(toLocalDateKey("not-a-date")).toBe("not-a-date");
  });
});

describe("strict backend future-time validation", () => {
  it("rejects genuinely future timestamps beyond clock skew limit on create", () => {
    const futureDate = new Date(
      Date.now() + ENTRY_INSTANT_CLOCK_SKEW_MS + 60_000,
    ).toISOString();
    const result = illnessEpisodeCreateSchema.safeParse({
      label: "Future Condition",
      type: "INFECTION",
      onsetAt: futureDate,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          issue.message.includes("must be a plausible instant"),
        ),
      ).toBe(true);
    }
  });

  it("rejects genuinely future timestamps beyond clock skew limit on update", () => {
    const futureDate = new Date(
      Date.now() + ENTRY_INSTANT_CLOCK_SKEW_MS + 60_000,
    ).toISOString();
    const result = illnessEpisodeUpdateSchema.safeParse({
      onsetAt: futureDate,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          issue.message.includes("must be a plausible instant"),
        ),
      ).toBe(true);
    }
  });

  it("rejects pre-1900 timestamps", () => {
    const result = illnessEpisodeCreateSchema.safeParse({
      label: "Ancient Condition",
      type: "INFECTION",
      onsetAt: "1899-12-31T23:59:59.000Z",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) =>
          issue.message.includes("must be a plausible instant"),
        ),
      ).toBe(true);
    }
  });
});

const MALFORMED_CALENDAR_DATES = [
  "",
  "   ",
  "\t",
  "\n",
  "not-a-date",
  "2026/11/10",
  "10-11-2026",
  "2026-1-1",
  "2026-11",
  "2026-11-10T00:00:00Z",
  "2026-11-10 extra",
];

const IMPOSSIBLE_CALENDAR_DATES = [
  "2026-02-29", // 2026 is not a leap year
  "1900-02-29", // 1900 is not a leap year (divisible by 100, not 400)
  "2026-02-30", // February never has 30 days
  "2026-04-31", // April has 30 days
  "2026-06-31", // June has 30 days
  "2026-09-31", // September has 30 days
  "2026-11-31", // November has 30 days
  "2026-00-15", // Month 00
  "2026-13-10", // Month 13
  "2026-11-00", // Day 00
  "2026-11-32", // Day 32
];

describe("isCalendarDateKey — validation of calendar dates", () => {
  it("rejects blank, whitespace, and malformed date strings", () => {
    for (const bad of MALFORMED_CALENDAR_DATES) {
      expect(isCalendarDateKey(bad)).toBe(false);
    }
  });

  it("rejects impossible calendar dates", () => {
    for (const bad of IMPOSSIBLE_CALENDAR_DATES) {
      expect(isCalendarDateKey(bad)).toBe(false);
    }
  });

  it("accepts valid calendar dates including leap years", () => {
    expect(isCalendarDateKey("2024-02-29")).toBe(true); // leap year
    expect(isCalendarDateKey("2000-02-29")).toBe(true); // 400-year leap year
    expect(isCalendarDateKey("2026-10-31")).toBe(true); // 31-day month
    expect(isCalendarDateKey("2026-11-10")).toBe(true);
  });
});

describe("serializeEpisodeDate — validation of date-only input", () => {
  const today = "2026-11-10";
  const now = new Date("2026-11-10T14:00:00.000Z");

  it("rejects blank and whitespace-only date inputs with a clear error", () => {
    for (const blank of ["", "   ", "\t", "\n", " \t \n "]) {
      expect(() => serializeEpisodeDate(blank, today, now)).toThrow(RangeError);
      expect(() => serializeEpisodeDate(blank, today, now)).toThrow(
        /Invalid episode calendar date/i,
      );
    }
  });

  it("rejects malformed date strings", () => {
    for (const bad of MALFORMED_CALENDAR_DATES) {
      expect(() => serializeEpisodeDate(bad, today, now)).toThrow(RangeError);
      expect(() => serializeEpisodeDate(bad, today, now)).toThrow(
        /Invalid episode calendar date/i,
      );
    }
  });

  it("rejects impossible calendar dates (non-leap year Feb 29, Feb 30, 31st of 30-day month, invalid month/day)", () => {
    for (const bad of IMPOSSIBLE_CALENDAR_DATES) {
      expect(() => serializeEpisodeDate(bad, today, now)).toThrow(RangeError);
      expect(() => serializeEpisodeDate(bad, today, now)).toThrow(
        /Invalid episode calendar date/i,
      );
    }
  });

  it("accepts valid calendar dates including leap years and serializes correctly", () => {
    // 2024 is a leap year (divisible by 4, not 100)
    const leapDate = "2024-02-29";
    const serializedLeap = serializeEpisodeDate(leapDate, today, now);
    expect(toLocalDateKey(serializedLeap)).toBe("2024-02-29");

    // 2000 is a leap year (divisible by 400)
    const centuryLeapDate = "2000-02-29";
    const serializedCenturyLeap = serializeEpisodeDate(
      centuryLeapDate,
      today,
      now,
    );
    expect(toLocalDateKey(serializedCenturyLeap)).toBe("2000-02-29");

    // Valid standard date
    const validDate = "2026-10-31";
    const serializedValid = serializeEpisodeDate(validDate, today, now);
    expect(toLocalDateKey(serializedValid)).toBe("2026-10-31");
  });

  it("rejects non-string runtime inputs with RangeError at the JS boundary", () => {
    for (const bad of [null, undefined, 12345, {}, []] as unknown as string[]) {
      expect(() => serializeEpisodeDate(bad, today, now)).toThrow(RangeError);
      expect(() => serializeEpisodeDate(bad, today, now)).toThrow(
        /Invalid episode calendar date/i,
      );
      expect(() => serializeEpisodeDate("2026-11-10", bad, now)).toThrow(
        RangeError,
      );
      expect(() => serializeEpisodeDate("2026-11-10", bad, now)).toThrow(
        /Invalid episode calendar date/i,
      );
    }
  });

  it("handles whitespace in both date and today arguments", () => {
    const serialized = serializeEpisodeDate(
      "  2026-11-10  ",
      " \t 2026-11-10 \n ",
      now,
      "UTC",
    );
    expect(toLocalDateKey(serialized, "UTC")).toBe("2026-11-10");
  });

  it("trims surrounding whitespace internally and serializes valid dates", () => {
    const whitespaceVariants = [
      " 2026-10-31 ",
      "  2026-10-31",
      "2026-10-31  ",
      "\t2026-10-31\n",
      "\r\n 2026-10-31 \t",
    ];
    for (const input of whitespaceVariants) {
      const serialized = serializeEpisodeDate(input, today, now, "UTC");
      expect(toLocalDateKey(serialized, "UTC")).toBe("2026-10-31");
      expect(new Date(serialized).getUTCHours()).toBe(12);
    }

    // Today with whitespace:
    const todayWithWhitespace = "  2026-11-10  ";
    const serializedToday = serializeEpisodeDate(
      todayWithWhitespace,
      today,
      now,
      "UTC",
    );
    expect(toLocalDateKey(serializedToday, "UTC")).toBe("2026-11-10");
  });
});

describe("resolveEpisodeInstant", () => {
  const today = "2026-11-10";
  const now = new Date("2026-11-10T14:00:00.000Z");

  it("preserves exact stored instant when calendar date is unchanged in active timezone", () => {
    // 2026-11-09T23:30:00.000Z is 2026-11-10 in Asia/Tokyo
    const stored = "2026-11-09T23:30:00.000Z";
    const result = resolveEpisodeInstant({
      date: "2026-11-10",
      storedInstant: stored,
      today,
      now,
      timeZone: "Asia/Tokyo",
    });
    expect(result).toBe(stored);
  });

  it("trims surrounding whitespace internally and preserves stored same-day instant", () => {
    const stored = "2026-11-09T23:30:00.000Z"; // 2026-11-10 in Asia/Tokyo
    const whitespaceVariants = [
      " 2026-11-10 ",
      "  2026-11-10",
      "2026-11-10  ",
      "\t2026-11-10\n",
      "\r\n 2026-11-10 \t",
    ];
    for (const input of whitespaceVariants) {
      const result = resolveEpisodeInstant({
        date: input,
        storedInstant: stored,
        today,
        now,
        timeZone: "Asia/Tokyo",
      });
      expect(result).toBe(stored);
    }
  });

  it("serializes to a new instant when calendar date differs from stored instant", () => {
    const stored = "2026-11-09T23:30:00.000Z";
    const result = resolveEpisodeInstant({
      date: "2026-11-08",
      storedInstant: stored,
      today,
      now,
      timeZone: "Asia/Tokyo",
    });
    expect(result).not.toBe(stored);
    expect(toLocalDateKey(result, "Asia/Tokyo")).toBe("2026-11-08");
  });

  it("serializes normally when storedInstant is null or undefined", () => {
    const resultUndefined = resolveEpisodeInstant({
      date: "2026-11-08",
      storedInstant: undefined,
      today,
      now,
      timeZone: "UTC",
    });
    expect(toLocalDateKey(resultUndefined, "UTC")).toBe("2026-11-08");

    const resultNull = resolveEpisodeInstant({
      date: "2026-11-08",
      storedInstant: null,
      today,
      now,
      timeZone: "UTC",
    });
    expect(toLocalDateKey(resultNull, "UTC")).toBe("2026-11-08");
  });
});

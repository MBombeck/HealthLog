/**
 * Illness episode date serialization, timezone handling & window tests.
 *
 * Covers:
 * - Before/after noon serialization (morning clamp to now vs noon anchor).
 * - UTC+14 and UTC-12 boundary timezones.
 * - Daylight Saving Time (DST) transitions.
 * - Preserving stored instant on edit when calendar date is unchanged.
 * - Same-day clamp (resolvedAt clamped up to onsetAt when resolved === onset).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { illnessEpisodeCreateSchema } from "@/lib/validations/illness";
import {
  resolveEpisodeInstant,
  resolveEpisodeWindow,
  serializeEpisodeDate,
  toLocalDateKey,
} from "../dates";

afterEach(() => {
  vi.useRealTimers();
});

describe("episode date serialization — before and after noon", () => {
  it("serializes today before local noon to now", () => {
    vi.useFakeTimers();
    try {
      const tz = "Europe/Berlin";
      // 08:30 local time on 2026-11-10 (07:30 UTC in CET)
      const now = new Date("2026-11-10T07:30:00.000Z");
      vi.setSystemTime(now);

      const onsetAt = serializeEpisodeDate("2026-11-10", tz);

      expect(onsetAt).toBe("2026-11-10T07:30:00.000Z");
      expect(toLocalDateKey(onsetAt, tz)).toBe("2026-11-10");

      const parsed = illnessEpisodeCreateSchema.safeParse({
        label: "Headache",
        type: "INFECTION",
        onsetAt,
      });
      expect(parsed.success).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes today after local noon and historical dates to local noon", () => {
    const tz = "Europe/Berlin";
    // 15:30 local time on 2026-11-10 (14:30 UTC in CET)
    const now = new Date("2026-11-10T14:30:00.000Z");

    // Today after noon anchors to local noon (12:00 CET = 11:00 UTC)
    const todayOnset = serializeEpisodeDate("2026-11-10", tz, now);
    expect(todayOnset).toBe("2026-11-10T11:00:00.000Z");
    expect(toLocalDateKey(todayOnset, tz)).toBe("2026-11-10");

    // Historical date also anchors to local noon
    const histOnset = serializeEpisodeDate("2026-11-05", tz, now);
    expect(histOnset).toBe("2026-11-05T11:00:00.000Z");
    expect(toLocalDateKey(histOnset, tz)).toBe("2026-11-05");
  });
});

describe("episode date serialization — extreme timezones (UTC+14 & UTC-12)", () => {
  it("preserves calendar date in UTC+14 (Pacific/Kiritimati)", () => {
    const tz = "Pacific/Kiritimati";
    // Local noon on 2026-11-10 in UTC+14 is 2026-11-09T22:00:00.000Z
    const now = new Date("2026-11-10T04:00:00.000Z"); // local 18:00
    const onsetAt = serializeEpisodeDate("2026-11-10", tz, now);

    expect(onsetAt).toBe("2026-11-09T22:00:00.000Z");
    expect(toLocalDateKey(onsetAt, tz)).toBe("2026-11-10");
  });

  it("preserves calendar date in UTC-12 (Etc/GMT+12)", () => {
    const tz = "Etc/GMT+12";
    // Local noon on 2026-11-10 in UTC-12 is 2026-11-11T00:00:00.000Z
    const now = new Date("2026-11-11T04:00:00.000Z"); // local 16:00
    const onsetAt = serializeEpisodeDate("2026-11-10", tz, now);

    expect(onsetAt).toBe("2026-11-11T00:00:00.000Z");
    expect(toLocalDateKey(onsetAt, tz)).toBe("2026-11-10");
  });
});

describe("episode date serialization — daylight saving time (DST)", () => {
  it("handles summer EDT (UTC-4) and winter EST (UTC-5) correctly", () => {
    const tz = "America/New_York";
    const now = new Date("2026-12-01T20:00:00.000Z");

    // Summer EDT (UTC-4): noon = 16:00 UTC
    const summerOnset = serializeEpisodeDate("2026-07-01", tz, now);
    expect(summerOnset).toBe("2026-07-01T16:00:00.000Z");
    expect(toLocalDateKey(summerOnset, tz)).toBe("2026-07-01");

    // Winter EST (UTC-5): noon = 17:00 UTC
    const winterOnset = serializeEpisodeDate("2026-01-15", tz, now);
    expect(winterOnset).toBe("2026-01-15T17:00:00.000Z");
    expect(toLocalDateKey(winterOnset, tz)).toBe("2026-01-15");
  });
});

describe("resolveEpisodeInstant & resolveEpisodeWindow", () => {
  it("preserves exact stored instant when calendar date is unchanged", () => {
    const tz = "America/New_York";
    const now = new Date("2026-11-10T15:00:00.000Z");
    const storedInstant = "2026-11-05T09:42:15.123Z";
    const calendarDate = toLocalDateKey(storedInstant, tz); // "2026-11-05"

    const resolved = resolveEpisodeInstant({
      date: calendarDate,
      storedInstant,
      now,
      timeZone: tz,
    });
    expect(resolved).toBe(storedInstant);

    // When the user changes the calendar date, it freshly serializes
    const changed = resolveEpisodeInstant({
      date: "2026-11-06",
      storedInstant,
      now,
      timeZone: tz,
    });
    expect(changed).toBe("2026-11-06T17:00:00.000Z");
  });

  it("clamps same-day resolvedAt up to onsetAt when resolved instant is earlier", () => {
    const tz = "UTC";
    const now = new Date("2026-11-10T10:00:00.000Z");
    // Both on 2026-11-10; storedResolved is 08:00 UTC, freshly serialized onsetAt is 10:00 UTC
    const window = resolveEpisodeWindow({
      onset: "2026-11-10",
      resolved: "2026-11-10",
      storedOnset: null,
      storedResolved: "2026-11-10T08:00:00.000Z",
      now,
      timeZone: tz,
    });

    expect(window.onsetAt).toBe("2026-11-10T10:00:00.000Z");
    // resolvedAt clamped up to onsetAt
    expect(window.resolvedAt).toBe(window.onsetAt);
  });
});

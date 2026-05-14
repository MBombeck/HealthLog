/**
 * v1.4.25 W7b — date-key contract for MoodEntry rows.
 *
 * Pin both halves of Decision A:
 *
 *   - Legacy rows (tz = null) are read as Europe/Berlin → continue to
 *     produce the same day-key the v1.4.24 write path would have.
 *
 *   - New rows with explicit non-Berlin tz produce a different
 *     day-key in line with the user's own clock — the regression we
 *     are fixing for non-Berlin users.
 */
import { describe, expect, it } from "vitest";
import { moodDateKey, effectiveMoodTz, DEFAULT_TIMEZONE } from "../date-key";

describe("moodDateKey", () => {
  it("formats a UTC instant as a Europe/Berlin YYYY-MM-DD by default", () => {
    // 2026-05-14T21:30:00Z = 23:30 in Berlin (CEST, UTC+2)
    expect(moodDateKey(new Date("2026-05-14T21:30:00Z"), "Europe/Berlin")).toBe(
      "2026-05-14",
    );
  });

  it("buckets a 23:50 Pacific/Auckland reading to the Auckland day", () => {
    // 2026-05-14T11:50:00Z = 23:50 Auckland (NZST, UTC+12) ; still
    // 13:50 Berlin (CEST, UTC+2). The Auckland bucket and the Berlin
    // bucket agree here — pick a UTC instant where they diverge.
    expect(
      moodDateKey(new Date("2026-05-14T11:50:00Z"), "Pacific/Auckland"),
    ).toBe("2026-05-14");
    expect(moodDateKey(new Date("2026-05-14T11:50:00Z"), "Europe/Berlin")).toBe(
      "2026-05-14",
    );

    // 2026-05-14T13:00:00Z = 01:00 next day Auckland, still
    // 15:00 same day Berlin. Pin the divergence.
    expect(
      moodDateKey(new Date("2026-05-14T13:00:00Z"), "Pacific/Auckland"),
    ).toBe("2026-05-15");
    expect(moodDateKey(new Date("2026-05-14T13:00:00Z"), "Europe/Berlin")).toBe(
      "2026-05-14",
    );
  });

  it("falls back to Europe/Berlin for empty or undefined tz", () => {
    expect(moodDateKey(new Date("2026-05-14T22:00:00Z"), "")).toBe(
      "2026-05-15",
    );
    expect(
      moodDateKey(
        new Date("2026-05-14T22:00:00Z"),
        undefined as unknown as string,
      ),
    ).toBe("2026-05-15");
  });
});

describe("effectiveMoodTz", () => {
  it("returns the row's explicit tz when set", () => {
    expect(effectiveMoodTz({ tz: "Pacific/Auckland" })).toBe(
      "Pacific/Auckland",
    );
  });

  it("returns Europe/Berlin for legacy rows (tz = null)", () => {
    expect(effectiveMoodTz({ tz: null })).toBe("Europe/Berlin");
    expect(effectiveMoodTz({ tz: undefined })).toBe("Europe/Berlin");
    expect(effectiveMoodTz({ tz: "" })).toBe("Europe/Berlin");
  });

  it("exposes the same fallback constant the writer uses", () => {
    expect(DEFAULT_TIMEZONE).toBe("Europe/Berlin");
  });
});

describe("read-path interpretation of legacy vs new rows", () => {
  // Build a row's day-key the way the route writes it: write the
  // instant `moodLoggedAt`, anchored to the row's resolved tz.
  function bucketFor(row: { moodLoggedAt: Date; tz: string | null }): string {
    return moodDateKey(row.moodLoggedAt, effectiveMoodTz(row));
  }

  it("legacy null-tz row buckets the same as a Europe/Berlin row at the same instant", () => {
    const instant = new Date("2026-05-14T22:00:00Z");
    const legacy = bucketFor({ moodLoggedAt: instant, tz: null });
    const explicitBerlin = bucketFor({
      moodLoggedAt: instant,
      tz: "Europe/Berlin",
    });
    expect(legacy).toBe(explicitBerlin);
    expect(legacy).toBe("2026-05-15");
  });

  it("new Pacific/Auckland row buckets differently from a legacy row at the same instant", () => {
    const instant = new Date("2026-05-14T13:00:00Z");
    const legacy = bucketFor({ moodLoggedAt: instant, tz: null });
    const akl = bucketFor({ moodLoggedAt: instant, tz: "Pacific/Auckland" });
    expect(legacy).toBe("2026-05-14");
    expect(akl).toBe("2026-05-15");
  });
});

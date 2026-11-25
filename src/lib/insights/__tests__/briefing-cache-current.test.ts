import { describe, expect, it } from "vitest";

import { cachedBriefingIsCurrent } from "@/lib/insights/briefing-payload";

const NOW = new Date("2026-11-25T12:00:00.000Z");

function text(payload: unknown): string {
  return JSON.stringify(payload);
}

const todays = {
  dailyBriefing: { paragraph: "Today.", keyFindings: [] },
  briefingGeneratedAt: "2026-11-25T06:00:00.000Z",
};

function current(
  overrides: Partial<Parameters<typeof cachedBriefingIsCurrent>[0]> = {},
) {
  return cachedBriefingIsCurrent({
    cachedText: text(todays),
    cachedAt: new Date("2026-11-25T06:00:00.000Z"),
    cachedLocale: "en",
    locale: "en",
    timezone: "UTC",
    now: NOW,
    ...overrides,
  });
}

describe("cachedBriefingIsCurrent", () => {
  it("holds for today's renderable briefing in the reader's language", () => {
    expect(current()).toBe(true);
  });

  it("counts an untagged row as the reader's language", () => {
    expect(current({ cachedLocale: null })).toBe(true);
  });

  it("refuses a row in another language", () => {
    expect(current({ cachedLocale: "de" })).toBe(false);
  });

  it("refuses an empty slot", () => {
    expect(current({ cachedText: null })).toBe(false);
    expect(current({ cachedAt: null })).toBe(false);
  });

  it("refuses a write older than 24 hours", () => {
    expect(current({ cachedAt: new Date("2026-11-24T11:59:59.000Z") })).toBe(
      false,
    );
  });

  it("refuses yesterday's text that a warm only re-stamped", () => {
    expect(
      current({
        cachedText: text({
          ...todays,
          briefingGeneratedAt: "2026-11-24T23:00:00.000Z",
        }),
        cachedAt: new Date("2026-11-25T11:59:00.000Z"),
      }),
    ).toBe(false);
  });

  it("judges the day on the reader's calendar", () => {
    // 23:30 UTC on the 24th is already the 25th in Melbourne.
    const cachedText = text({
      ...todays,
      briefingGeneratedAt: "2026-11-24T23:30:00.000Z",
    });
    expect(current({ cachedText, timezone: "Australia/Melbourne" })).toBe(true);
    expect(current({ cachedText, timezone: "UTC" })).toBe(false);
  });

  it("refuses text without a generation moment", () => {
    expect(
      current({ cachedText: text({ dailyBriefing: todays.dailyBriefing }) }),
    ).toBe(false);
  });

  it("refuses a briefing the card cannot render", () => {
    expect(
      current({
        cachedText: text({
          ...todays,
          dailyBriefing: { paragraph: "Today.", keyFindings: "not a list" },
        }),
      }),
    ).toBe(false);
  });

  it("refuses today's text without a briefing", () => {
    expect(
      current({
        cachedText: text({ briefingGeneratedAt: todays.briefingGeneratedAt }),
      }),
    ).toBe(false);
  });

  it("refuses text that does not parse", () => {
    expect(current({ cachedText: "{not json" })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  readBriefingGeneratedAt,
  withBriefingGeneratedAt,
} from "@/lib/insights/briefing-generated-at";

describe("briefing generation moment", () => {
  it("round-trips through the stored JSON text", () => {
    const at = new Date("2026-10-05T04:30:00.000Z");
    const text = JSON.stringify(
      withBriefingGeneratedAt({ dailyBriefing: { paragraph: "x" } }, at),
    );
    expect(readBriefingGeneratedAt(text)).toBe(at.toISOString());
  });

  it("is unknown for a payload that predates it, or does not parse", () => {
    expect(readBriefingGeneratedAt(JSON.stringify({ dailyBriefing: {} }))).toBe(
      null,
    );
    expect(readBriefingGeneratedAt("not json")).toBeNull();
    expect(readBriefingGeneratedAt(null)).toBeNull();
    expect(
      readBriefingGeneratedAt({ briefingGeneratedAt: "yesterday-ish" }),
    ).toBeNull();
  });
});

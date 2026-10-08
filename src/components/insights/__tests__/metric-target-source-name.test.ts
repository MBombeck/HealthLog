import { describe, expect, it } from "vitest";

import { sourceName } from "../metric-target-summary";

describe("sourceName", () => {
  const t = (key: string) => `t:${key}`;
  it("names the plain-description sources in the reader's language", () => {
    expect(sourceName("Mood entries", t)).toBe(
      "t:targets.sourceNames.moodEntries",
    );
    expect(sourceName("7-day", t)).toBe("t:targets.sourceNames.sevenDays");
  });
  it("leaves a citation as it is", () => {
    expect(sourceName("ESH 2023", t)).toBe("ESH 2023");
  });
});

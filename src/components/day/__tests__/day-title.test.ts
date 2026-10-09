/**
 * A cycle and a trip reach the day view under a sentinel title the client
 * words in the reader's language. The record's kind decides that, so a
 * medication or a document someone named "cycle" keeps its own name.
 */
import { describe, expect, it } from "vitest";

import { dayTitle } from "../day-sections";

const t = (key: string, params?: Record<string, string | number>) =>
  params ? `t:${key}(${Object.values(params).join(",")})` : `t:${key}`;

describe("dayTitle", () => {
  it("words the cycle and travel sentinels", () => {
    expect(dayTitle("cyclePhase", "cycle", t)).toBe("t:nav.cycle");
    expect(dayTitle("cycleDayLog", "cycle", t)).toBe("t:nav.cycle");
    expect(dayTitle("travel", "travel", t)).toBe("t:day.travel");
  });

  it("keeps a record's own title that happens to read like a sentinel", () => {
    expect(dayTitle("medication", "cycle", t)).toBe("cycle");
    expect(dayTitle("document", "travel", t)).toBe("travel");
  });

  it("says what happened to a medication, not only its name", () => {
    expect(dayTitle("pauseStart", "Ramipril", t)).toBe(
      "t:day.event.paused(Ramipril)",
    );
    expect(dayTitle("pauseEnd", "Ramipril", t)).toBe(
      "t:day.event.resumed(Ramipril)",
    );
    expect(dayTitle("medicationPause", "Ramipril", t)).toBe(
      "t:day.event.paused(Ramipril)",
    );
    expect(dayTitle("medicationStart", "Ramipril", t)).toBe(
      "t:day.event.started(Ramipril)",
    );
    expect(dayTitle("medicationEnd", "Ramipril", t)).toBe(
      "t:day.event.ended(Ramipril)",
    );
  });
});

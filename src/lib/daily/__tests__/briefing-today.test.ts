import { describe, expect, it } from "vitest";

import type { DailyBriefing } from "@/lib/ai/schema";
import {
  briefingForToday,
  formatSignalDelta,
} from "@/lib/daily/briefing-today";

describe("formatSignalDelta", () => {
  it("reads a pulse difference in whole beats (de)", () => {
    expect(
      formatSignalDelta("+33,72 bpm vs. dein 30-Tage-Mittel", "pulse", "de"),
    ).toBe("+34 bpm vs. dein 30-Tage-Mittel");
  });

  it("reads a pulse difference in whole beats (en)", () => {
    expect(
      formatSignalDelta("+33.72 bpm vs your 30-day average", "pulse", "en"),
    ).toBe("+34 bpm vs your 30-day average");
  });

  it("reads weight at one decimal in both languages", () => {
    expect(
      formatSignalDelta("−0,37 kg seit letzter Woche", "weight", "de"),
    ).toBe("−0,4 kg seit letzter Woche");
    expect(formatSignalDelta("-0.37 kg since last week", "weight", "en")).toBe(
      "-0.4 kg since last week",
    );
  });

  it("leaves a figure already at its precision, and a grouped thousand, alone", () => {
    expect(
      formatSignalDelta("+6 mmHg vs your 30-day average", "bp", "en"),
    ).toBe("+6 mmHg vs your 30-day average");
    expect(formatSignalDelta("+1,2 kg", "weight", "de")).toBe("+1,2 kg");
    // "1.234" is a thousand in German, never a decimal to round.
    expect(formatSignalDelta("1.234 bpm", "pulse", "de")).toBe("1.234 bpm");
  });

  it("drops the sign of a difference that rounds to nothing", () => {
    expect(formatSignalDelta("+0.3 bpm vs your normal", "pulse", "en")).toBe(
      "0 bpm vs your normal",
    );
  });

  it("keeps a metric that is not a single reading verbatim", () => {
    expect(formatSignalDelta("−42,5 Min.", "sleep", "de")).toBe("−42,5 Min.");
  });
});

const BRIEFING: DailyBriefing = {
  paragraph: "Dein Puls ist heute deutlich erhöht.",
  signalsOfDay: [
    {
      sourceMetric: "pulse",
      tone: "watch",
      headline: "Puls ist heute deutlich erhöht",
      nudge: "Gönn dir heute etwas Ruhe.",
      delta: "+33,72 bpm vs. dein 30-Tage-Mittel",
    },
    {
      sourceMetric: "sleep",
      tone: "info",
      headline: "Kürzere Nacht",
      nudge: "Heute etwas früher ins Bett.",
      delta: null,
    },
  ],
  keyFindings: [],
};

/** 2026-10-05 21:00 in Berlin, the time the defect was seen. */
const BERLIN = {
  timezone: "Europe/Berlin",
  todayLocalDate: "2026-10-05",
  language: "de" as const,
};

describe("briefingForToday", () => {
  it("drops a pulse signal whose last reading was yesterday at 08:50", () => {
    const out = briefingForToday(BRIEFING, {
      ...BERLIN,
      updatedAt: "2026-10-05T04:00:00Z",
      lastSeenAt: (type) => (type === "PULSE" ? "2026-10-04T06:50:00Z" : null),
    });
    expect(out?.signalsOfDay?.map((s) => s.sourceMetric)).toEqual(["sleep"]);
  });

  it("keeps a pulse signal measured today, with its delta in whole beats", () => {
    const out = briefingForToday(BRIEFING, {
      ...BERLIN,
      updatedAt: "2026-10-05T04:00:00Z",
      lastSeenAt: (type) => (type === "PULSE" ? "2026-10-05T06:50:00Z" : null),
    });
    expect(out?.signalsOfDay?.[0]?.delta).toBe(
      "+34 bpm vs. dein 30-Tage-Mittel",
    );
  });

  it("serves no briefing written on an earlier day, just after midnight", () => {
    // Written 23:30 on the 4th, read 00:10 on the 5th (Berlin).
    expect(
      briefingForToday(BRIEFING, {
        ...BERLIN,
        updatedAt: "2026-10-04T21:30:00Z",
        lastSeenAt: () => "2026-10-04T21:00:00Z",
      }),
    ).toBeNull();
  });

  it("decides the day in the reader's zone", () => {
    // 05:00 UTC on the 5th is the evening of the 4th in Los Angeles.
    const ctx = {
      updatedAt: "2026-10-05T05:00:00Z",
      lastSeenAt: () => "2026-10-05T05:00:00Z",
      language: "en" as const,
    };
    expect(
      briefingForToday(BRIEFING, {
        ...ctx,
        timezone: "America/Los_Angeles",
        todayLocalDate: "2026-10-05",
      }),
    ).toBeNull();
    expect(
      briefingForToday(BRIEFING, {
        ...ctx,
        timezone: "UTC",
        todayLocalDate: "2026-10-05",
      })?.signalsOfDay?.length,
    ).toBe(2);
  });
});

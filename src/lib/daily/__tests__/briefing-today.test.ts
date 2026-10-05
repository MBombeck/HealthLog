import { describe, expect, it } from "vitest";

import type { DailyBriefing } from "@/lib/ai/schema";
import { locales } from "@/lib/i18n/config";
import { resolveIntlLocale } from "@/lib/format-locale";
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

  it("says ±0 for a difference that rounds to nothing, never an unsigned zero", () => {
    expect(formatSignalDelta("+0.3 bpm vs your normal", "pulse", "en")).toBe(
      "±0 bpm vs your normal",
    );
    expect(formatSignalDelta("+0.04 kg", "weight", "en")).toBe("±0.0 kg");
  });

  it("re-writes a figure in the reader's own number format", () => {
    // An English-formatted figure inside German text was cut at the comma
    // into "+1,2.5 kg".
    expect(formatSignalDelta("+1,234.5 kg", "weight", "de")).toBe(
      "+1.234,5 kg",
    );
    expect(formatSignalDelta("+1.234,56 kg", "weight", "de")).toBe(
      "+1.234,6 kg",
    );
  });

  it("reads glucose at the precision of the unit it is written in", () => {
    expect(formatSignalDelta("+12.4 mg/dL", "glucose", "en")).toBe("+12 mg/dL");
    expect(formatSignalDelta("+0,74 mmol/L", "glucose", "de")).toBe(
      "+0,7 mmol/L",
    );
  });

  it("keeps a metric that is not a single reading verbatim", () => {
    expect(formatSignalDelta("−42,5 Min.", "sleep", "de")).toBe("−42,5 Min.");
  });
});

describe.each(locales)("formatSignalDelta in %s", (locale) => {
  const intl = resolveIntlLocale(locale);
  // The locale's own grouping convention: Spanish and Polish leave a
  // four-digit figure ungrouped, French groups with a thin space.
  const fmt = (value: number, digits: number) =>
    new Intl.NumberFormat(intl, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);

  it("rounds a pulse difference to whole beats", () => {
    expect(formatSignalDelta(`+${fmt(33.72, 2)} bpm`, "pulse", locale)).toBe(
      "+34 bpm",
    );
  });

  it("reads weight at one decimal, grouping included", () => {
    expect(formatSignalDelta(`−${fmt(1234.56, 2)} kg`, "weight", locale)).toBe(
      `−${fmt(1234.6, 1)} kg`,
    );
  });

  it("keeps the sign of a small difference as ±0 at weight precision", () => {
    expect(formatSignalDelta(`+${fmt(0.04, 2)} kg`, "weight", locale)).toBe(
      `±${fmt(0, 1)} kg`,
    );
  });

  it("re-reads an English-formatted figure in the reader's format", () => {
    expect(formatSignalDelta("+1,234.5 kg", "weight", locale)).toBe(
      `+${fmt(1234.5, 1)} kg`,
    );
  });

  it("leaves plain integers and window words as written", () => {
    expect(formatSignalDelta("+6 mmHg vs 30-day", "bp", locale)).toBe(
      "+6 mmHg vs 30-day",
    );
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

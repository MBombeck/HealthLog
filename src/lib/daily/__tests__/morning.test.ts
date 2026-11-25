/**
 * The morning sentence's rule table: every state the page can be in maps to
 * exactly one rank, and the first rule that holds wins. Each case states the
 * facts and the one rank they must produce; a rule that moves breaks the row
 * that pins it.
 */
import { describe, expect, it } from "vitest";

import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { TodayVital } from "@/lib/daily/today-overview";
import {
  buildDailyMorning,
  buildMorningLead,
  MORNING_LEAD_KEYS,
  rankOf,
  type MorningInput,
  type MorningLeadKey,
} from "@/lib/daily/morning";

const t = getServerTranslator("en").t;
const NOW = new Date("2026-11-26T07:30:00Z");
const TODAY = "2026-11-26";

function vital(over: Partial<TodayVital> = {}): TodayVital {
  return {
    type: "RESTING_HEART_RATE",
    value: 54,
    low: 50,
    high: 58,
    direction: "in",
    daysAgo: 0,
    valueLabel: "54 bpm",
    rangeLabel: "50 to 58 bpm",
    moduleKey: null,
    ...over,
  };
}

const out = (type: string, over: Partial<TodayVital> = {}) =>
  vital({
    type,
    value: 99,
    direction: "above",
    valueLabel: "99",
    rangeLabel: "50 to 58",
    ...over,
  });

function input(over: Partial<MorningInput> = {}): MorningInput {
  return {
    locale: "en",
    modules: {},
    now: NOW,
    todayKey: TODAY,
    floor: null,
    restMode: null,
    vitals: [],
    illnessExplained: false,
    sleepExpected: false,
    sleepPending: false,
    sleep: null,
    latestNightLabel: null,
    sleepScore: null,
    sleepSourceValues: [],
    quiet: [],
    readiness: null,
    recoverySourceValues: [],
    dosesToday: 0,
    visitToday: null,
    readinessAsOfLabel: null,
    ...over,
  };
}

const readiness = (
  over: Partial<NonNullable<MorningInput["readiness"]>> = {},
): NonNullable<MorningInput["readiness"]> => ({
  score: 58,
  band: "yellow",
  fresh: true,
  asOfDay: TODAY,
  components: [
    { key: "rhr", value: 40, weight: 0.25 },
    { key: "hrv", value: 70, weight: 0.25 },
    { key: "sleep", value: 80, weight: 0.25 },
    { key: "mood", value: 20, weight: 0.15 },
    { key: "respiratory", value: null, weight: 0 },
  ],
  ...over,
});

const quietSince = (sinceDay: string, hoursAgo: number) => ({
  name: "WHOOP",
  since: new Date(NOW.getTime() - hoursAgo * 3_600_000),
  sinceDay,
});

function leadOf(over: Partial<MorningInput>) {
  return buildMorningLead(input(over), t);
}

function expectRank(over: Partial<MorningInput>, key: MorningLeadKey) {
  const lead = leadOf(over);
  expect(lead.key).toBe(key);
  expect(lead.rank).toBe(rankOf(key));
  return lead;
}

describe("morning lead: one rank per state", () => {
  it("numbers the ranks 0 to 10 in the documented order", () => {
    expect(MORNING_LEAD_KEYS.map((k) => rankOf(k))).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it("rank 0: a confirmed floor wins over everything, with its value", () => {
    const lead = expectRank(
      {
        floor: { reason: "bp_hypertensive", valueLabel: "184/122 mmHg" },
        restMode: { day: 3 },
        vitals: [out("BLOOD_PRESSURE_SYS"), out("RESTING_HEART_RATE")],
        sleepPending: true,
      },
      "floor",
    );
    expect(lead.text).toBe(
      "Blood pressure reached 184/122 mmHg in the last 24 hours.",
    );
  });

  it("rank 1: Rest mode, counted in days", () => {
    expect(expectRank({ restMode: { day: 4 } }, "rest_mode").text).toBe(
      "Rest mode for 3 days, so today's readings serve only as context.",
    );
    expect(expectRank({ restMode: { day: 1 } }, "rest_mode").text).toBe(
      "Rest mode since today, so readings serve only as context.",
    );
  });

  it("rank 1 does not speak when the illness module is off", () => {
    expectRank(
      { restMode: { day: 4 }, modules: { illness: false } },
      "nothing",
    );
  });

  it("rank 2: blood pressure and heart rate are two independent signals", () => {
    const lead = expectRank(
      {
        vitals: [
          out("BLOOD_PRESSURE_SYS"),
          out("BLOOD_PRESSURE_DIA"),
          out("RESTING_HEART_RATE"),
        ],
      },
      "coincident",
    );
    expect(lead.text).toBe(
      "Blood pressure and heart rate are outside your usual range today.",
    );
  });

  it("rank 2 during an illness keeps its own calm wording", () => {
    const lead = expectRank(
      {
        vitals: [out("HEART_RATE_VARIABILITY"), out("RESTING_HEART_RATE")],
        illnessExplained: true,
      },
      "coincident",
    );
    expect(lead.text).toBe(
      "During the current illness, heart rate and HRV are outside your usual range.",
    );
  });

  it("rank 3, not 2: systolic plus diastolic is one blood pressure", () => {
    expectRank(
      { vitals: [out("BLOOD_PRESSURE_SYS"), out("BLOOD_PRESSURE_DIA")] },
      "vital_outside",
    );
  });

  it("rank 3, not 2: weight plus glucose never coincide", () => {
    expectRank(
      { vitals: [out("WEIGHT"), out("BLOOD_GLUCOSE")] },
      "vital_outside",
    );
  });

  it("rank 3: one value outside names it with the compared mean", () => {
    const lead = expectRank(
      {
        vitals: [
          out("RESTING_HEART_RATE", {
            valueLabel: "61 bpm",
            rangeLabel: "52 to 57 bpm",
          }),
          vital({ type: "HEART_RATE_VARIABILITY" }),
        ],
        readiness: readiness({ band: "red" }),
      },
      "vital_outside",
    );
    expect(lead.text).toBe(
      "Resting heart rate averages 61 bpm today, above your usual range (52 to 57 bpm).",
    );
  });

  it("rank 3: a value from yesterday says nothing about today", () => {
    expectRank(
      { vitals: [out("RESTING_HEART_RATE", { daysAgo: 1 })] },
      "nothing",
    );
  });

  it("rank 4: sleep expected and last night not in", () => {
    expect(
      expectRank(
        { sleepExpected: true, sleepPending: true, readiness: readiness() },
        "sleep_pending",
      ).text,
    ).toBe("Last night's sleep is not in yet.");
  });

  it("rank 4 does not speak when the sleep module is off", () => {
    expectRank(
      {
        sleepExpected: true,
        sleepPending: true,
        modules: { sleep: false },
      },
      "nothing",
    );
  });

  it("rank 5: a quiet source on its first day", () => {
    expect(
      expectRank(
        { quiet: [quietSince("2026-11-25", 14)], readiness: readiness() },
        "source_quiet",
      ).text,
    ).toBe("WHOOP has sent nothing for 14 hours.");
  });

  it("rank 5 stops on the third day and leaves it to the rail", () => {
    expectRank({ quiet: [quietSince("2026-11-23", 70)] }, "nothing");
  });

  it("rank 6: fresh yellow readiness names its heaviest deduction", () => {
    expect(expectRank({ readiness: readiness() }, "readiness").text).toBe(
      "Readiness 58, held back most by resting heart rate.",
    );
  });

  it("rank 6 is silent when readiness is not fresh", () => {
    expectRank({ readiness: readiness({ fresh: false }) }, "nothing");
  });

  it("rank 6 is silent for green readiness; the night or the values speak", () => {
    expectRank(
      {
        readiness: readiness({ band: "green", score: 82 }),
        vitals: [vital(), vital({ type: "HEART_RATE_VARIABILITY" })],
      },
      "in_range",
    );
  });

  it("rank 7: a night an hour off the usual", () => {
    expectRank(
      { sleep: { minutes: 330, usualMinutes: 450 }, sleepExpected: true },
      "night_notable",
    );
  });

  it("rank 8 counts: a cuff reading in range is two values, never 'everything'", () => {
    const lead = expectRank(
      {
        vitals: [
          vital({ type: "BLOOD_PRESSURE_SYS" }),
          vital({ type: "BLOOD_PRESSURE_DIA" }),
        ],
      },
      "in_range",
    );
    expect(lead.text).toBe(
      "All 2 of today's values sit inside their usual range.",
    );
  });

  it("rank 8: a scale reading alone in range names it", () => {
    expect(
      expectRank(
        { vitals: [vital({ type: "WEIGHT", valueLabel: "80 kg" })] },
        "in_range",
      ).text,
    ).toMatch(/^Weight averages 80 kg today, inside your usual range/);
  });

  it("rank 8: an ordinary night with no values today", () => {
    expectRank(
      { sleep: { minutes: 440, usualMinutes: 450 }, sleepExpected: true },
      "in_range",
    );
  });

  it("rank 9: no values, but doses and a visit planned", () => {
    expect(
      expectRank(
        { dosesToday: 3, visitToday: { timeLabel: "09:30" } },
        "planned",
      ).text,
    ).toBe("Today: 3 doses and a visit at 09:30.");
    expect(expectRank({ dosesToday: 1 }, "planned").text).toBe(
      "Today: 1 dose planned.",
    );
  });

  it("rank 9 leaves doses out when the medications module is off", () => {
    expectRank({ dosesToday: 3, modules: { medications: false } }, "nothing");
  });

  it("rank 10: nothing at all", () => {
    expect(expectRank({}, "nothing").text).toBe("No readings yet today.");
  });
});

describe("morning cards", () => {
  it("draws the sleep ring only for last night", () => {
    const base = {
      sleepExpected: true,
      sleep: { minutes: 440, usualMinutes: 450 },
    };
    const tonight = buildDailyMorning(
      input({
        ...base,
        sleepScore: { score: 81, band: "green", night: TODAY },
      }),
      t,
    );
    expect(tonight.cards[0]).toMatchObject({
      kind: "night",
      ring: { score: 81, band: "green", fresh: true, asOfDay: TODAY },
    });
    const older = buildDailyMorning(
      input({
        ...base,
        sleepScore: { score: 81, band: "green", night: "2026-11-25" },
      }),
      t,
    );
    expect(older.cards[0].ring).toBeNull();
  });

  it("says a pending night is not in yet, with the latest night on record", () => {
    const m = buildDailyMorning(
      input({
        sleepExpected: true,
        sleepPending: true,
        latestNightLabel: "Nov 25",
      }),
      t,
    );
    expect(m.cards[0].lines.map((l) => l.text)).toEqual([
      "Not in yet",
      "Latest night: Nov 25",
    ]);
  });

  it("shows no number from stale readiness, only the last value as past", () => {
    const m = buildDailyMorning(
      input({
        readiness: readiness({ fresh: false, asOfDay: "2026-11-24" }),
        readinessAsOfLabel: "Nov 24",
      }),
      t,
    );
    const card = m.cards.find((c) => c.kind === "today_different");
    expect(card?.ring).toEqual({
      score: null,
      band: null,
      fresh: false,
      asOfDay: "2026-11-24",
    });
    expect(card?.lines.map((l) => l.text)).toEqual(["Last 58 on Nov 24"]);
  });

  it("drops the band in Rest mode", () => {
    const m = buildDailyMorning(
      input({ readiness: readiness(), restMode: { day: 2 } }),
      t,
    );
    const card = m.cards.find((c) => c.kind === "today_different");
    expect(card?.ring?.band).toBeNull();
    expect(card?.ring?.score).toBe(58);
  });

  it("lists the outside values instead of readiness, leading to the signal card", () => {
    const m = buildDailyMorning(
      input({
        readiness: readiness(),
        vitals: [out("RESTING_HEART_RATE"), out("HEART_RATE_VARIABILITY")],
      }),
      t,
    );
    const card = m.cards.find((c) => c.kind === "today_different");
    expect(card?.href).toBe("/insights");
    expect(card?.ring).toBeNull();
    expect(card?.lines).toHaveLength(2);
  });

  it("names at most two readiness contributors, heaviest deduction first", () => {
    const m = buildDailyMorning(input({ readiness: readiness() }), t);
    const card = m.cards.find((c) => c.kind === "today_different");
    expect(card?.lines.map((l) => l.text)).toEqual([
      "fair",
      "Resting heart rate: 40 of 100",
      "Mood stability: 20 of 100",
    ]);
  });

  it("carries no card for an empty account", () => {
    expect(buildDailyMorning(input(), t).cards).toEqual([]);
  });
});

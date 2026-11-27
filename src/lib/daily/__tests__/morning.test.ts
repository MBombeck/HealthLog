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
  SLEEP_PENDING_LEAD_UNTIL_HOUR,
  rankOf,
  type MorningInput,
  type MorningLeadKey,
} from "@/lib/daily/morning";
import { floorFromReadings } from "@/lib/daily/morning-floor";
import { resolveLastNight } from "@/lib/sleep/last-night";

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
    localHour: 8,
    floor: null,
    floorReading: null,
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
    scoreFlag: null,
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

  it("rank 4 speaks until local noon, then the day's values do", () => {
    const pending = {
      sleepExpected: true,
      sleepPending: true,
      vitals: [vital(), vital({ type: "HEART_RATE_VARIABILITY" })],
    };
    expectRank(
      { ...pending, localHour: SLEEP_PENDING_LEAD_UNTIL_HOUR - 1 },
      "sleep_pending",
    );
    expect(expectRank({ ...pending, localHour: 21 }, "in_range").text).toBe(
      "All 2 of today's values sit inside their usual range.",
    );
    // The night card still says it is not in.
    const morning = buildDailyMorning(input({ ...pending, localHour: 21 }), t);
    const night = morning.cards.find((c) => c.kind === "night");
    expect(night?.lines[0]?.text).toBe(t("daily.morningCard.nightPending"));
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

  it("rank 8 does not hold while a reading past a safety floor stands unconfirmed", () => {
    // 182/121 sits inside a personal range that runs this high, so the
    // counted vitals call it usual; the floor says otherwise.
    const lead = expectRank(
      {
        vitals: [
          vital({ type: "BLOOD_PRESSURE_SYS", value: 182 }),
          vital({ type: "BLOOD_PRESSURE_DIA", value: 121 }),
        ],
        floorReading: { reason: "bp_hypertensive", valueLabel: "182/121 mmHg" },
        sleepExpected: true,
        sleepPending: true,
      },
      "vital_outside",
    );
    expect(lead.text).toBe(
      "Blood pressure reached 182/121 mmHg in the last 24 hours.",
    );
  });

  it("rank 8 names the flagged pillar instead of calling the day in range", () => {
    const vitals = [
      vital({ type: "BLOOD_PRESSURE_SYS" }),
      vital({ type: "BLOOD_PRESSURE_DIA" }),
    ];
    const lead = expectRank(
      {
        vitals,
        scoreFlag: { band: "yellow", pillar: "BLOOD_PRESSURE" },
      },
      "in_range",
    );
    expect(lead.text).toBe(
      "Blood pressure needs attention in your health score today.",
    );
    expect(lead.text).not.toMatch(/usual range/);
    // A pillar not known (an older payload): the score is named.
    expect(
      expectRank(
        { vitals, scoreFlag: { band: "red", pillar: null } },
        "in_range",
      ).text,
    ).toBe(
      "Your health score marks an area outside its reference range today.",
    );
  });

  it("rank 8 with a flagged score and no values today: the night speaks", () => {
    expect(
      expectRank(
        {
          sleep: { minutes: 440, usualMinutes: 450 },
          sleepExpected: true,
          scoreFlag: { band: "red", pillar: "BLOOD_PRESSURE" },
        },
        "in_range",
      ).text,
    ).toMatch(/^Last night you slept .*close to your usual\.$/);
  });

  it("rank 8: a night 40 minutes short is not called usual", () => {
    expect(
      expectRank(
        { sleep: { minutes: 410, usualMinutes: 450 }, sleepExpected: true },
        "in_range",
      ).text,
    ).toMatch(/40m less than usual\.$/);
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

/**
 * One rule for "last night" in the morning: the sleep score's night, whose
 * wake day is the reader's today. The sentence, the duration line, the
 * ring, "not in yet" and the pending state all read this one fact, so the
 * card can never say "not in yet" beside last night's ring, or give a
 * duration that belongs to the night before.
 */
describe("last night, one rule", () => {
  const base = {
    todayKey: TODAY,
    sleepOn: true,
    sleepExpected: true,
    morningRefreshedToday: false,
    usualMinutes: 450,
  };

  it("does not call yesterday's night last night 23 h 40 min later", () => {
    // Woke yesterday at 06:40, opened today at 06:20 before the sync: a
    // rolling 24-hour window would still call that night "last night".
    const night = resolveLastNight({
      ...base,
      night: { night: "2026-11-25", asleepMinutes: 310 },
    });
    expect(night).toEqual({
      sleep: null,
      sleepPending: true,
      latestNightDay: "2026-11-25",
    });
    const m = buildDailyMorning(
      input({
        sleepExpected: true,
        sleepPending: night.sleepPending,
        sleep: night.sleep,
        latestNightLabel: "Nov 25",
        sleepScore: { score: 70, band: "green", night: "2026-11-25" },
      }),
      t,
    );
    expect(m.lead.key).toBe("sleep_pending");
    expect(m.cards[0].ring).toBeNull();
    expect(m.cards[0].lines.map((l) => l.text)).toEqual([
      "Not in yet",
      "Latest night: Nov 25",
    ]);
  });

  it("takes a night that arrived after the snapshot, ring and line together", () => {
    // The sleep score already reads this morning's night; the snapshot that
    // used to decide the line still had yesterday's.
    const night = resolveLastNight({
      ...base,
      night: { night: TODAY, asleepMinutes: 440 },
    });
    expect(night).toEqual({
      sleep: { minutes: 440, usualMinutes: 450 },
      sleepPending: false,
      latestNightDay: null,
    });
    const m = buildDailyMorning(
      input({
        sleepExpected: true,
        sleepPending: night.sleepPending,
        sleep: night.sleep,
        sleepScore: { score: 81, band: "green", night: TODAY },
      }),
      t,
    );
    expect(m.cards[0].ring).toMatchObject({ score: 81, asOfDay: TODAY });
    expect(m.cards[0].lines.map((l) => l.text)).not.toContain("Not in yet");
  });

  it("never names today as the latest night when only in-bed time is in", () => {
    const night = resolveLastNight({
      ...base,
      night: { night: TODAY, asleepMinutes: 0 },
    });
    expect(night.sleep).toBeNull();
    expect(night.sleepPending).toBe(true);
    expect(night.latestNightDay).toBeNull();
  });

  it("is not pending once the morning refresh ran, or with sleep off", () => {
    const stale = {
      night: { night: "2026-11-25", asleepMinutes: 310 },
    };
    expect(
      resolveLastNight({ ...base, ...stale, morningRefreshedToday: true })
        .sleepPending,
    ).toBe(false);
    expect(resolveLastNight({ ...base, ...stale, sleepOn: false })).toEqual({
      sleep: null,
      sleepPending: false,
      latestNightDay: null,
    });
  });

  it("draws no ring beside a night that is not in", () => {
    const m = buildDailyMorning(
      input({
        sleepExpected: true,
        sleepPending: true,
        sleep: null,
        sleepScore: { score: 81, band: "green", night: TODAY },
      }),
      t,
    );
    expect(m.cards[0].ring).toBeNull();
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
      "Readiness in a middle range",
      "Resting heart rate: 40 of 100",
      "Mood stability: 20 of 100",
    ]);
  });

  it("opens with a readiness line in sentence case for every band, in German too", () => {
    const de = getServerTranslator("de").t;
    const first = (band: "green" | "yellow" | "red", tr = t) =>
      buildDailyMorning(input({ readiness: readiness({ band }) }), tr).cards[0]
        .lines[0].text;
    expect(first("green")).toBe("Readiness in a good range");
    expect(first("red")).toBe("Readiness in a low range");
    expect(first("green", de)).toBe("Bereitschaft im guten Bereich");
    expect(first("yellow", de)).toBe("Bereitschaft im mittleren Bereich");
  });

  it("does not name the sleep score twice when the night card shows it", () => {
    const sleepHeavy = readiness({
      components: [
        { key: "sleep", value: 30, weight: 0.25 },
        { key: "rhr", value: 40, weight: 0.25 },
        { key: "mood", value: 20, weight: 0.15 },
        { key: "hrv", value: 90, weight: 0.25 },
      ],
    });
    const linesOf = (over: Partial<MorningInput>) =>
      buildDailyMorning(input({ readiness: sleepHeavy, ...over }), t)
        .cards.find((c) => c.kind === "today_different")
        ?.lines.map((l) => l.text);
    // Last night is on the night card: the next deductions stand in.
    expect(
      linesOf({
        sleepExpected: true,
        sleep: { minutes: 400, usualMinutes: 450 },
        sleepScore: { score: 75, band: "green", night: TODAY },
      }),
    ).toEqual([
      "Readiness in a middle range",
      "Resting heart rate: 40 of 100",
      "Mood stability: 20 of 100",
    ]);
    // No ring for last night: the sleep score is named here.
    expect(
      linesOf({
        sleepScore: { score: 75, band: "green", night: "2026-11-25" },
      }),
    ).toEqual([
      "Readiness in a middle range",
      "Sleep score: 30 of 100",
      "Resting heart rate: 40 of 100",
    ]);
  });

  it("carries no card for an empty account", () => {
    expect(buildDailyMorning(input(), t).cards).toEqual([]);
  });

  it("titles every card from the closed set, worded in the response language", () => {
    const de = getServerTranslator("de").t;
    const m = buildDailyMorning(
      input({
        locale: "de",
        sleepExpected: true,
        sleepPending: true,
        readiness: readiness(),
      }),
      de,
    );
    expect(m.cards.map((c) => [c.titleKey, c.title])).toEqual([
      ["daily.morningCard.title.night", "Letzte Nacht"],
      ["daily.morningCard.title.todayDifferent", "Heute anders"],
    ]);
    expect(m.toDo).toEqual({
      titleKey: "daily.morningCard.title.toDo",
      title: "Heute zu tun",
    });
  });
});

describe("floor readings", () => {
  const label = (mgdl: number) => `${mgdl} mg/dL`;

  it("names the most extreme reading past the floor, or nothing", () => {
    const bp = [
      { sys: 150, dia: 95 },
      { sys: 176, dia: 121 },
      { sys: 184, dia: 100 },
    ];
    expect(floorFromReadings({ bp, glucose: [] }, null, label)).toEqual({
      reason: "bp_hypertensive",
      valueLabel: "184/100 mmHg",
    });
    expect(
      floorFromReadings(
        { bp: [{ sys: 150, dia: 95 }], glucose: [] },
        null,
        label,
      ),
    ).toBeNull();
  });

  it("reads glucose against its threshold, not the window's extreme alone", () => {
    // A confirmed low whose reading is gone must not print an ordinary value.
    expect(
      floorFromReadings({ bp: [], glucose: [96, 110] }, "glucose_hypo", label),
    ).toBeNull();
    expect(
      floorFromReadings(
        { bp: [], glucose: [96, 62, 58] },
        "glucose_hypo",
        label,
      ),
    ).toEqual({ reason: "glucose_hypo", valueLabel: "58 mg/dL" });
    expect(
      floorFromReadings({ bp: [], glucose: [96, 52] }, null, label),
    ).toEqual({ reason: "glucose_hypo_severe", valueLabel: "52 mg/dL" });
    expect(
      floorFromReadings({ bp: [], glucose: [260, 240] }, null, label),
    ).toEqual({ reason: "glucose_hyper", valueLabel: "260 mg/dL" });
  });
});

describe("morning scores: the start page's sleep and readiness tiles", () => {
  it("has no tile for a score the record does not produce", () => {
    const m = buildDailyMorning(input(), t);
    expect(m.scores).toEqual({ sleep: null, readiness: null });
    const off = buildDailyMorning(
      input({
        modules: { sleep: false, recovery: false },
        sleepExpected: true,
        readiness: readiness(),
      }),
      t,
    );
    expect(off.scores).toEqual({ sleep: null, readiness: null });
  });

  it("scores last night with its time asleep", () => {
    const m = buildDailyMorning(
      input({
        sleepExpected: true,
        sleep: { minutes: 440, usualMinutes: 450 },
        sleepScore: { score: 81, band: "green", night: TODAY },
      }),
      t,
    );
    expect(m.scores.sleep).toMatchObject({
      ring: { score: 81, band: "green", fresh: true, asOfDay: TODAY },
      line: "7h 20m",
    });
  });

  it("shows no number for an older night, and says the night is not in", () => {
    const m = buildDailyMorning(
      input({
        sleepExpected: true,
        sleepPending: true,
        sleepScore: { score: 81, band: "green", night: "2026-11-25" },
      }),
      t,
    );
    expect(m.scores.sleep).toMatchObject({
      ring: { score: null, band: null, fresh: false, asOfDay: "2026-11-25" },
      line: "Not in yet",
    });
  });

  it("names the heaviest pull on readiness, not the sleep score beside it", () => {
    const m = buildDailyMorning(
      input({
        readiness: readiness({
          components: [
            { key: "sleep", value: 10, weight: 0.5 },
            { key: "rhr", value: 40, weight: 0.25 },
          ],
        }),
        sleepExpected: true,
        sleep: { minutes: 440, usualMinutes: 450 },
        sleepScore: { score: 30, band: "red", night: TODAY },
      }),
      t,
    );
    expect(m.scores.readiness).toMatchObject({
      ring: { score: 58, band: "yellow", fresh: true },
      line: "Resting HR 40/100",
    });
  });

  it("keeps a stale readiness without a number, with its last value as past", () => {
    const m = buildDailyMorning(
      input({
        readiness: readiness({ fresh: false, asOfDay: "2026-11-24" }),
        readinessAsOfLabel: "Nov 24",
      }),
      t,
    );
    expect(m.scores.readiness).toMatchObject({
      ring: { score: null, band: null, fresh: false, asOfDay: "2026-11-24" },
      line: "Last 58 on Nov 24",
    });
  });

  it("drops the band in Rest mode but keeps the number", () => {
    const m = buildDailyMorning(
      input({ readiness: readiness(), restMode: { day: 2 } }),
      t,
    );
    expect(m.scores.readiness?.ring).toMatchObject({ score: 58, band: null });
  });
});

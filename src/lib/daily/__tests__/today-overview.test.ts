import { describe, it, expect } from "vitest";

import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { Locale } from "@/lib/i18n/config";
import type { DailyBriefing } from "@/lib/ai/schema";
import type { MedsTodayBlock } from "@/lib/dashboard/meds-today";
import type { PriorityItem } from "@/lib/daily/priority-item";
import {
  buildTodayOverview,
  firstSubstantiveSentence,
  isGreetingOnly,
  MAX_TODAY_FACTS,
  type TodayOverviewInput,
  type TodayVital,
} from "@/lib/daily/today-overview";

const t = getServerTranslator("en").t;

function meds(over: Partial<MedsTodayBlock> = {}): MedsTodayBlock {
  return {
    activeCount: 0,
    scheduledToday: 0,
    takenToday: 0,
    skippedToday: 0,
    nextDueAt: null,
    nextDueOverdue: false,
    nextDueMedicationName: null,
    nextDueMedicationId: null,
    ...over,
  };
}

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

/** A quiet day with nothing at all to say. */
function input(over: Partial<TodayOverviewInput> = {}): TodayOverviewInput {
  return {
    locale: "en",
    modules: {},
    reactionLine: null,
    briefing: null,
    scoreValue: 94,
    medsToday: meds(),
    visits: [],
    rail: [],
    restMode: null,
    sleep: null,
    vitals: [],
    cycle: null,
    ...over,
  };
}

const briefing = (paragraph: string, headline?: string): DailyBriefing => ({
  paragraph,
  signalsOfDay: headline
    ? [
        {
          sourceMetric: "pulse",
          tone: "info",
          headline,
          nudge: "",
          delta: null,
        },
      ]
    : [],
  keyFindings: [],
});

/** Every fact the builder can produce, all at once. */
function busyDay(over: Partial<TodayOverviewInput> = {}): TodayOverviewInput {
  return input({
    restMode: { day: 3 },
    medsToday: meds({ scheduledToday: 3, takenToday: 1 }),
    visits: [
      { id: "v1", dayOffset: 1, timeLabel: "09:30", what: "Dr. Example" },
    ],
    sleep: { minutes: 440, usualMinutes: 430 },
    vitals: [
      vital(),
      vital({ type: "HEART_RATE_VARIABILITY", valueLabel: "48 ms" }),
    ],
    cycle: { dayOfCycle: 12, phase: "FOLLICULAR" },
    // An AI lead keeps every fact in the list; the deterministic lead would
    // take one of them.
    briefing: briefing("Resting heart rate held at 54 bpm overnight."),
    ...over,
  });
}

describe("greeting detection", () => {
  it.each([
    "Good morning.",
    "Good evening!",
    "Hello there.",
    "Guten Morgen.",
    "Hallo!",
    "Buenos días.",
    "Bonjour !",
    "Buongiorno.",
    "Dzień dobry.",
    "좋은 아침이에요.",
    "안녕하세요.",
    "Welcome back.",
    "Nice.",
  ])("treats %j as a greeting", (sentence) => {
    expect(isGreetingOnly(sentence)).toBe(true);
  });

  it.each([
    "Good morning, your resting heart rate is 52.",
    "High blood pressure readings eased this week.",
    "Morning blood pressure sat in the optimal band all week.",
    "Your sleep landed right around your target again.",
  ])("treats %j as content", (sentence) => {
    expect(isGreetingOnly(sentence)).toBe(false);
  });
});

describe("firstSubstantiveSentence", () => {
  it("skips a greeting and leads with the sentence that says something", () => {
    expect(
      firstSubstantiveSentence(
        "Good morning. Your latest blood pressure is sitting in the optimal band.",
        94,
      ),
    ).toBe("Your latest blood pressure is sitting in the optimal band.");
  });

  it("skips a sentence that only repeats the ring's number", () => {
    expect(
      firstSubstantiveSentence(
        "Your health score is 94. Sleep dipped slightly last night.",
        94,
      ),
    ).toBe("Sleep dipped slightly last night.");
  });

  it("keeps a sentence where the score's digits are part of another figure", () => {
    // Score 52, and a sleep duration that happens to end in 52 minutes.
    expect(
      firstSubstantiveSentence("You slept 7 h 52 min, a solid night.", 52),
    ).toBe("You slept 7 h 52 min, a solid night.");
    expect(
      firstSubstantiveSentence("Your resting heart rate is 52 bpm.", 52),
    ).toBe("Your resting heart rate is 52 bpm.");
    expect(
      firstSubstantiveSentence("You walked 52 minutes more than usual.", 52),
    ).toBe("You walked 52 minutes more than usual.");
  });

  it("still skips the score sentence in every shipped language", () => {
    for (const sentence of [
      "Your health score is 52.",
      "Dein Gesundheitsscore heute liegt bei 52.",
      "Tu puntuación de salud hoy es 52.",
      "Ton score de santé aujourd'hui est de 52.",
      "Il tuo punteggio di salute oggi è 52.",
      "오늘 건강 점수는 52점이에요.",
      "Twój dzisiejszy wynik zdrowia to 52.",
      "You are at 52/100 today.",
    ]) {
      expect(
        firstSubstantiveSentence(`${sentence} Sleep dipped last night.`, 52),
        sentence,
      ).toBe("Sleep dipped last night.");
    }
  });

  it("keeps decimals inside one sentence", () => {
    expect(
      firstSubstantiveSentence("You slept 7.5 hours, a solid night.", null),
    ).toBe("You slept 7.5 hours, a solid night.");
  });

  it("returns null when nothing qualifies", () => {
    expect(firstSubstantiveSentence("Good morning. Hi!", 94)).toBeNull();
    expect(firstSubstantiveSentence("", 94)).toBeNull();
    expect(firstSubstantiveSentence(null, 94)).toBeNull();
  });
});

describe("lead precedence", () => {
  it("prefers the reaction line over the briefing", () => {
    const o = buildTodayOverview(
      input({
        reactionLine: "A solid night, deeper than your recent stretch.",
        briefing: briefing("Your week is trending steady."),
      }),
      t,
    );
    expect(o.lead).toEqual({
      text: "A solid night, deeper than your recent stretch.",
      source: "reaction",
    });
  });

  it("drops a greeting-only reaction line and falls through", () => {
    const o = buildTodayOverview(
      input({
        reactionLine: "Good morning!",
        briefing: briefing("Your week is trending steady."),
      }),
      t,
    );
    expect(o.lead).toEqual({
      text: "Your week is trending steady.",
      source: "briefing",
    });
  });

  it("never leads with 'Good morning.' (the defect this replaces)", () => {
    const o = buildTodayOverview(
      input({
        briefing: briefing(
          "Good morning. Your latest blood pressure is sitting in the optimal band.",
        ),
      }),
      t,
    );
    expect(o.lead?.text).toBe(
      "Your latest blood pressure is sitting in the optimal band.",
    );
    expect(o.briefingLead).toBe(o.lead?.text);
  });

  it("leads with the top-signal headline when the paragraph has nothing", () => {
    const o = buildTodayOverview(
      input({
        briefing: briefing("Your health score is 94.", "Pulse is settling"),
      }),
      t,
    );
    expect(o.lead).toEqual({ text: "Pulse is settling", source: "briefing" });
  });

  it("builds a deterministic lead when no AI text exists", () => {
    const o = buildTodayOverview(
      input({ vitals: [vital(), vital({ type: "HEART_RATE_VARIABILITY" })] }),
      t,
    );
    expect(o.lead).toEqual({
      text: "All 2 of your latest vitals sit inside their usual range.",
      source: "signal",
    });
  });

  it("has no lead, and no filler, when there is nothing to say", () => {
    const o = buildTodayOverview(input(), t);
    expect(o.lead).toBeNull();
    expect(o.today).toEqual([]);
  });
});

describe("deterministic lead — strongest signal", () => {
  it("names the vital furthest outside its range, with its numbers", () => {
    const o = buildTodayOverview(
      input({
        vitals: [
          vital({ value: 60, direction: "above", valueLabel: "60 bpm" }),
          vital({
            type: "HEART_RATE_VARIABILITY",
            value: 20,
            low: 40,
            high: 60,
            direction: "below",
            valueLabel: "20 ms",
            rangeLabel: "40 to 60 ms",
          }),
        ],
      }),
      t,
    );
    // HRV is a full band width below; resting HR a quarter above.
    expect(o.lead?.text).toBe(
      "Heart-rate variability is at 20 ms, below your usual range of 40 to 60 ms, and 1 more vital is outside its range too.",
    );
    expect(o.lead?.source).toBe("signal");
  });

  it("says a single out-of-range vital plainly", () => {
    const o = buildTodayOverview(
      input({
        vitals: [
          vital({ value: 61, direction: "above", valueLabel: "61 bpm" }),
        ],
      }),
      t,
    );
    expect(o.lead?.text).toBe(
      "Resting heart rate is at 61 bpm, above your usual range of 50 to 58 bpm.",
    );
  });

  it("puts an unusual night ahead of calm vitals", () => {
    const o = buildTodayOverview(
      input({
        sleep: { minutes: 330, usualMinutes: 440 },
        vitals: [vital(), vital({ type: "PULSE" })],
      }),
      t,
    );
    expect(o.lead?.text).toBe(
      "Last night you slept 5h 30m, 1h 50m less than usual.",
    );
    // The night is the lead, so it is not repeated as a fact; the vitals stay.
    expect(o.today.map((f) => f.kind)).toEqual(["vitals"]);
  });

  it("removes the fact it was built from, and only that one", () => {
    const o = buildTodayOverview(
      input({
        vitals: [vital(), vital({ type: "PULSE" })],
        sleep: { minutes: 440, usualMinutes: 430 },
      }),
      t,
    );
    expect(o.lead?.source).toBe("signal");
    expect(o.today.map((f) => f.kind)).toEqual(["sleep"]);
  });

  it("reads an ordinary night when there is nothing else", () => {
    const o = buildTodayOverview(
      input({ sleep: { minutes: 440, usualMinutes: 430 } }),
      t,
    );
    expect(o.lead?.text).toBe(
      "Last night you slept 7h 20m, close to your usual.",
    );
    expect(o.today).toEqual([]);
  });

  it("says nothing about today from yesterday's reading", () => {
    // A pulse from yesterday morning, read at nine in the evening: neither
    // the lead nor the vitals line may call it today's.
    const o = buildTodayOverview(
      input({
        vitals: [
          vital({
            type: "PULSE",
            daysAgo: 1,
            direction: "above",
            value: 98,
            high: 72,
            valueLabel: "98 bpm",
            rangeLabel: "58 to 72 bpm",
          }),
        ],
      }),
      t,
    );
    expect(o.lead).toBeNull();
    expect(o.today.some((f) => f.kind === "vitals")).toBe(false);
  });

  it("speaks about a vital measured today", () => {
    const o = buildTodayOverview(
      input({
        vitals: [
          vital({
            type: "PULSE",
            daysAgo: 0,
            direction: "above",
            value: 98,
            high: 72,
            valueLabel: "98 bpm",
            rangeLabel: "58 to 72 bpm",
          }),
        ],
      }),
      t,
    );
    expect(o.lead?.source).toBe("signal");
    expect(o.lead?.text).toContain("98 bpm");
  });

  it("ignores a vital from days ago", () => {
    const o = buildTodayOverview(
      input({
        vitals: [vital({ daysAgo: 4, direction: "above", value: 70 })],
      }),
      t,
    );
    expect(o.lead).toBeNull();
    expect(o.today).toEqual([]);
  });
});

describe("AI on and off", () => {
  it("keeps the same facts with and without AI text", () => {
    const withAi = buildTodayOverview(busyDay({ restMode: null }), t);
    const withoutAi = buildTodayOverview(
      busyDay({ restMode: null, briefing: null }),
      t,
    );
    expect(withAi.lead?.source).toBe("briefing");
    expect(withoutAi.lead?.source).toBe("signal");
    // Without AI the deterministic lead takes the vitals line; every other
    // fact is identical.
    expect(withAi.today.filter((f) => f.kind !== "vitals")).toEqual(
      withoutAi.today,
    );
  });
});

describe("Today facts", () => {
  it("orders facts by priority and caps them at five, never padding", () => {
    const o = buildTodayOverview(busyDay(), t);
    expect(o.today.map((f) => f.kind)).toEqual([
      "rest_mode",
      "medications",
      "appointment",
      "sleep",
      "vitals",
    ]);
    expect(o.today).toHaveLength(MAX_TODAY_FACTS);
  });

  it("states values without asking for anything", () => {
    const o = buildTodayOverview(busyDay(), t);
    const byKind = Object.fromEntries(o.today.map((f) => [f.kind, f]));
    expect(byKind.rest_mode.value).toBe("Day 3");
    expect(byKind.medications.value).toBe("1 of 3 taken");
    expect(byKind.appointment.value).toBe("Tomorrow 09:30, Dr. Example");
    expect(byKind.sleep.value).toBe("7h 20m, close to your usual");
    expect(byKind.vitals.value).toBe("2 checked, all in your range");
    for (const fact of o.today) {
      expect(fact.value).not.toMatch(/\b(please|log|add|record|measure)\b/i);
    }
  });

  it("shows the cycle once there is room for it", () => {
    const o = buildTodayOverview(busyDay({ restMode: null }), t);
    expect(o.today.at(-1)).toMatchObject({
      kind: "cycle",
      value: "Follicular, day 12",
      href: "/cycle",
    });
  });

  it("says only the day while the cycle phase is withheld", () => {
    const o = buildTodayOverview(
      input({ cycle: { dayOfCycle: 4, phase: null } }),
      t,
    );
    expect(o.today).toEqual([
      expect.objectContaining({ kind: "cycle", value: "Day 4" }),
    ]);
  });

  it("names the out-of-range vital in the vitals line", () => {
    const o = buildTodayOverview(
      input({
        briefing: briefing("Your week is trending steady."),
        vitals: [
          vital({ direction: "above", value: 61 }),
          vital({ type: "PULSE" }),
        ],
      }),
      t,
    );
    expect(o.today).toEqual([
      expect.objectContaining({
        kind: "vitals",
        value: "Resting heart rate above your range",
      }),
    ]);
  });

  it("skips medications when nothing is scheduled today", () => {
    const o = buildTodayOverview(
      input({ medsToday: meds({ activeCount: 2, scheduledToday: 0 }) }),
      t,
    );
    expect(o.today).toEqual([]);
  });
});

describe("module gating", () => {
  const cases: Array<[string, TodayOverviewInput["modules"], string]> = [
    ["illness", { illness: false }, "rest_mode"],
    ["medications", { medications: false }, "medications"],
    ["sleep", { sleep: false }, "sleep"],
    ["cycle", { cycle: false }, "cycle"],
  ];

  it.each(cases)(
    "drops the %s fact when its module is off",
    (_name, modules, kind) => {
      const on = buildTodayOverview(busyDay({ restMode: null }), t);
      const all = buildTodayOverview(
        busyDay(kind === "rest_mode" ? {} : { restMode: null }),
        t,
      );
      const off = buildTodayOverview(
        busyDay({
          modules,
          ...(kind === "rest_mode" ? {} : { restMode: null }),
        }),
        t,
      );
      expect([...on.today, ...all.today].some((f) => f.kind === kind)).toBe(
        true,
      );
      expect(off.today.some((f) => f.kind === kind)).toBe(false);
    },
  );

  it("never builds a sleep lead with the sleep module off", () => {
    const o = buildTodayOverview(
      input({
        modules: { sleep: false },
        sleep: { minutes: 300, usualMinutes: 440 },
      }),
      t,
    );
    expect(o.lead).toBeNull();
  });

  it("leaves out a vital whose module is off", () => {
    const o = buildTodayOverview(
      input({
        modules: { glucose: false },
        vitals: [
          vital({
            type: "BLOOD_GLUCOSE",
            moduleKey: "glucose",
            direction: "above",
            value: 200,
          }),
        ],
      }),
      t,
    );
    expect(o.lead).toBeNull();
    expect(o.today).toEqual([]);
  });

  it("keeps everything with every module on", () => {
    const o = buildTodayOverview(busyDay({ restMode: null }), t);
    expect(o.today.map((f) => f.kind)).toEqual([
      "medications",
      "appointment",
      "sleep",
      "vitals",
      "cycle",
    ]);
  });
});

describe("appointments", () => {
  const rail = (kind: PriorityItem["kind"]): PriorityItem[] => [
    { kind, title: "x", status: "info", actions: [] },
  ];

  it("shows today before tomorrow", () => {
    const o = buildTodayOverview(
      input({
        visits: [
          { id: "b", dayOffset: 1, timeLabel: "08:00", what: "Dentist" },
          { id: "a", dayOffset: 0, timeLabel: "16:15", what: "GP" },
        ],
      }),
      t,
    );
    expect(o.today[0].value).toBe("Today 16:15, GP");
  });

  it("says nothing about the day after tomorrow", () => {
    const o = buildTodayOverview(
      input({
        visits: [{ id: "a", dayOffset: 2, timeLabel: "10:00", what: "GP" }],
      }),
      t,
    );
    expect(o.today).toEqual([]);
  });

  it("counts further visits on the same day", () => {
    const o = buildTodayOverview(
      input({
        visits: [
          { id: "a", dayOffset: 0, timeLabel: "09:00", what: "GP" },
          { id: "b", dayOffset: 0, timeLabel: "11:00", what: "Lab" },
        ],
      }),
      t,
    );
    expect(o.today[0].value).toBe("Today 09:00, GP +1");
  });

  it("does not repeat a visit the rail already shows", () => {
    const o = buildTodayOverview(
      input({
        visits: [{ id: "a", dayOffset: 0, timeLabel: "09:00", what: "GP" }],
        rail: rail("upcoming_visit"),
      }),
      t,
    );
    expect(o.today).toEqual([]);
  });

  it("still shows it when the rail holds something else", () => {
    const o = buildTodayOverview(
      input({
        visits: [{ id: "a", dayOffset: 0, timeLabel: "09:00", what: "GP" }],
        rail: rail("dose_window"),
      }),
      t,
    );
    expect(o.today).toHaveLength(1);
  });
});

describe("locales", () => {
  it.each(["de", "es", "fr", "it", "pl", "ko"] as Locale[])(
    "resolves every %s string from its own bundle",
    (locale) => {
      const tl = getServerTranslator(locale).t;
      const o = buildTodayOverview(
        busyDay({ locale, restMode: null, briefing: null }),
        tl,
      );
      const en = buildTodayOverview(
        busyDay({ restMode: null, briefing: null }),
        t,
      );
      expect(o.lead?.text).toBeTruthy();
      expect(o.lead?.text).not.toBe(en.lead?.text);
      for (const fact of o.today) {
        expect(fact.label).not.toMatch(/^daily\./);
        expect(fact.value).not.toMatch(/daily\./);
      }
    },
  );

  it("uses the Polish few-form for two to four", () => {
    const tl = getServerTranslator("pl").t;
    const o = buildTodayOverview(
      input({
        locale: "pl",
        vitals: [vital(), vital({ type: "PULSE" }), vital({ type: "WEIGHT" })],
      }),
      tl,
    );
    expect(o.lead?.text).toBe(
      "Wszystkie 3 ostatnie parametry życiowe mieszczą się w zwykłym zakresie.",
    );
  });
});

describe("lead length — whole sentences, never a word cut in half", () => {
  // The shape a live briefing produced: one sentence well past the lead's
  // budget, which used to be sliced mid-word ("…sleep landed r…").
  const LONG =
    "Today's picture is a calm one: your most recent blood pressure sits comfortably in the optimal band, resting heart rate is low, and last night's sleep landed right on your usual.";

  /** Every word of the lead is a whole word of the source text. */
  function wordsAreWhole(lead: string, source: string) {
    const sourceWords = new Set(source.split(/\s+/));
    const words = lead.replace(/…$/, "").trim().split(/\s+/);
    for (const word of words) {
      expect(
        sourceWords.has(word) ||
          [...sourceWords].some((w) => w.replace(/[,;:]$/, "") === word),
      ).toBe(true);
    }
  }

  it("leads with the first sentence when it fits", () => {
    const o = buildTodayOverview(
      input({
        briefing: briefing(
          "Your blood pressure sat in the optimal band all week. Sleep was steady too.",
        ),
      }),
      t,
    );
    expect(o.lead?.text).toBe(
      "Your blood pressure sat in the optimal band all week.",
    );
  });

  it("does not cut an over-long first sentence; the headline leads instead", () => {
    const o = buildTodayOverview(
      input({
        briefing: briefing(
          LONG,
          "Your latest blood pressure is sitting in the optimal band.",
        ),
      }),
      t,
    );
    expect(o.lead).toEqual({
      text: "Your latest blood pressure is sitting in the optimal band.",
      source: "briefing",
    });
  });

  it("falls to the deterministic sentence before it would cut model text", () => {
    const o = buildTodayOverview(
      input({ briefing: briefing(LONG), vitals: [vital()] }),
      t,
    );
    expect(o.lead?.source).toBe("signal");
    expect(o.lead?.text).not.toContain("…");
  });

  it("shortens at a word boundary only when nothing else is left", () => {
    const o = buildTodayOverview(input({ briefing: briefing(LONG) }), t);
    const text = o.lead?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(160);
    expect(text.endsWith("…")).toBe(true);
    wordsAreWhole(text, LONG);
    expect(text).not.toMatch(/[,;:]…$/);
  });

  it("keeps whole reaction sentences that fit and drops the one that does not", () => {
    const o = buildTodayOverview(
      input({
        reactionLine: `A solid night, deeper than your recent stretch. ${LONG}`,
      }),
      t,
    );
    expect(o.lead).toEqual({
      text: "A solid night, deeper than your recent stretch.",
      source: "reaction",
    });
  });

  it("keeps briefingLead word-safe for the push line", () => {
    const lead = firstSubstantiveSentence(LONG, null) ?? "";
    expect(lead.length).toBeLessThanOrEqual(160);
    wordsAreWhole(lead, LONG);
  });
});

describe("signal line under the lead — nothing said twice", () => {
  const BP_HEADLINE =
    "Your latest blood pressure is sitting in the optimal band.";
  const BP_DELTA = "↓ ~10 mmHg systolic vs the start of the window";

  function withSignal(
    paragraph: string,
    signal: Partial<NonNullable<DailyBriefing["signalsOfDay"]>[number]> = {},
  ): DailyBriefing {
    return {
      paragraph,
      signalsOfDay: [
        {
          sourceMetric: "bp",
          tone: "good",
          headline: BP_HEADLINE,
          nudge: "Keep the routine.",
          delta: BP_DELTA,
          ...signal,
        },
      ],
      keyFindings: [],
    };
  }

  it("keeps only the delta when the lead already talks about the metric", () => {
    const o = buildTodayOverview(
      input({
        briefing: withSignal(
          "Your most recent blood pressure sits comfortably in the optimal band, and resting heart rate is low.",
        ),
      }),
      t,
    );
    expect(o.lead?.source).toBe("briefing");
    expect(o.signalLine).toEqual({ headline: null, delta: BP_DELTA });
  });

  it("drops the line when the lead covers the metric and there is no delta", () => {
    const o = buildTodayOverview(
      input({
        briefing: withSignal("Blood pressure held steady all week.", {
          delta: null,
        }),
      }),
      t,
    );
    expect(o.signalLine).toBeNull();
  });

  it("recognises the metric in the reader's language", () => {
    const de = getServerTranslator("de").t;
    const o = buildTodayOverview(
      input({
        locale: "de",
        briefing: withSignal(
          "Dein Blutdruck lag die ganze Woche im optimalen Bereich.",
          { headline: "Dein Blutdruck liegt im optimalen Bereich." },
        ),
      }),
      de,
    );
    expect(o.signalLine).toEqual({ headline: null, delta: BP_DELTA });
  });

  it("keeps headline and delta when the lead is about something else", () => {
    const o = buildTodayOverview(
      input({ briefing: withSignal("Last night's sleep ran long and deep.") }),
      t,
    );
    expect(o.signalLine).toEqual({ headline: BP_HEADLINE, delta: BP_DELTA });
  });

  it("carries no line when the headline itself is the lead", () => {
    const o = buildTodayOverview(
      input({ briefing: withSignal("Your health score is 94.") }),
      t,
    );
    expect(o.lead?.text).toBe(BP_HEADLINE);
    expect(o.signalLine).toEqual({ headline: null, delta: BP_DELTA });
  });

  it("carries no line under a deterministic lead or without a briefing", () => {
    expect(
      buildTodayOverview(input({ vitals: [vital()] }), t).signalLine,
    ).toBeNull();
    expect(buildTodayOverview(input(), t).signalLine).toBeNull();
  });
});

describe("signal line — a metric is named by whole words, not by fragments", () => {
  const DELTA = "↓ 50 min vs your usual";

  function lineFor(
    lead: string,
    sourceMetric: NonNullable<
      DailyBriefing["signalsOfDay"]
    >[number]["sourceMetric"],
  ) {
    return buildTodayOverview(
      input({
        briefing: {
          paragraph: lead,
          signalsOfDay: [
            {
              sourceMetric,
              tone: "info",
              headline: "A headline the lead does not quote.",
              nudge: "n",
              delta: DELTA,
            },
          ],
          keyFindings: [],
        },
      }),
      t,
    ).signalLine;
  }

  // Each lead talks about something else; a fragment inside another word
  // used to count as naming the metric, and the headline was dropped.
  it.each([
    ["Your weight has risen slightly this week.", "sleep"], // "sen"
    ["You have chosen a steady routine.", "sleep"], // "sen"
    ["Your readings worsen a little after lunch.", "sleep"], // "sen"
    ["A snug fit for the cuff gave a clean reading.", "sleep"], // "snu"
    ["Poranne ciśnienie spadło po spacerze.", "sleep"], // "spa" (pl)
    ["잠시 후 다시 측정해 보세요.", "sleep"], // 잠시 = "a moment"
    ["Passing showers kept the walk short.", "steps"], // "passi"
    ["Ho passato una giornata tranquilla.", "steps"], // "passi" (it) inside passato
    ["A sudden impulse to rest was a good call.", "pulse"], // "puls"
    ["Der Impuls zur Pause war richtig.", "pulse"], // "puls" (de)
    ["L'impulsione del giorno era calma.", "pulse"], // "puls" (it)
    ["Wypadł impuls do odpoczynku.", "pulse"], // "puls" (pl)
  ] as const)("keeps the headline under %j (%s)", (lead, metric) => {
    const line = lineFor(lead, metric);
    expect(line?.headline).toBe("A headline the lead does not quote.");
  });

  it.each([
    ["Last night you slept seven hours.", "sleep"],
    ["Dein Schlaf war ruhig.", "sleep"],
    ["Tu sueño fue tranquilo.", "sleep"],
    ["Tu as bien dormi.", "sleep"],
    ["Il sonno è stato regolare.", "sleep"],
    ["Twój sen był spokojny.", "sleep"],
    ["Mało snu tej nocy.", "sleep"],
    ["Spałeś siedem godzin.", "sleep"],
    ["어젯밤 잠을 잘 잤어요.", "sleep"],
    ["수면 시간이 길었어요.", "sleep"],
    ["Hai fatto molti passi oggi.", "steps"],
    ["Your pulse settled overnight.", "pulse"],
    ["Dein Puls war ruhig.", "pulse"],
    ["Twój puls był spokojny.", "pulse"],
    ["Il polso era regolare.", "pulse"],
    ["Ton pouls était calme.", "pulse"],
  ] as const)("still recognises %j as naming %s", (lead, metric) => {
    expect(lineFor(lead, metric)).toEqual({ headline: null, delta: DELTA });
  });
});

describe("lead length — the ellipsis counts toward the budget", () => {
  it("stays within 160 characters for text without a single space", () => {
    // A digit keeps it from reading as a greeting (too few words).
    const unbroken = `${"a".repeat(400)}1.`;
    const lead = firstSubstantiveSentence(unbroken, null) ?? "";
    expect(lead.endsWith("…")).toBe(true);
    expect(lead.length).toBeLessThanOrEqual(160);
  });

  it("stays within 160 characters when the last space sits at the budget", () => {
    const text = `${"b".repeat(159)} ${"c".repeat(39)}1.`;
    const lead = firstSubstantiveSentence(text, null) ?? "";
    expect(lead.length).toBeLessThanOrEqual(160);
    // The space at the edge still ends a whole word.
    expect(lead).toBe(`${"b".repeat(159)}…`);
  });
});

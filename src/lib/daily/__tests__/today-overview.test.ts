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

  it("ignores a vital that is not from today or yesterday", () => {
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

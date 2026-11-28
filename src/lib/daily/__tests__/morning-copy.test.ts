/**
 * The morning sentence, rendered in every shipped language: each rank's every
 * plural form, with the longest name the language has for the slot. One
 * sentence, at most 120 characters, no exclamation mark, and none of the
 * words a finding has no business using (advice, alarm, diagnosis, the
 * "everything is fine" the rules never check).
 */
import { describe, expect, it } from "vitest";

import { locales, type Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { SIGNAL_FAMILIES } from "@/lib/insights/derived/coincident-deviation";
import { VITALS_BASELINE_TYPES } from "@/lib/insights/derived/registry";
import { buildMorningLead, type MorningInput } from "@/lib/daily/morning";
import type { TodayVital } from "@/lib/daily/today-overview";

const MAX = 120;

/** Words a morning sentence never uses, per language (lower case). */
const BLOCKED: Record<Locale, string[]> = {
  en: [
    "should",
    "must",
    "warning",
    "danger",
    "diagnos",
    "everything",
    "all good",
    "alarm",
  ],
  de: [
    "solltest",
    "musst",
    "warnung",
    "gefahr",
    "gefährlich",
    "diagnose",
    "alles",
    "achtung",
    "alarm",
  ],
  fr: [
    "devriez",
    "devez",
    "attention",
    "danger",
    "diagnostic",
    "tout va",
    "alerte",
  ],
  es: [
    "deberías",
    "debes",
    "cuidado",
    "peligro",
    "diagnóstico",
    "todo bien",
    "alerta",
  ],
  it: [
    "dovresti",
    "devi",
    "attenzione",
    "pericolo",
    "diagnosi",
    "tutto bene",
    "allarme",
  ],
  pl: [
    "powinieneś",
    "powinnaś",
    "musisz",
    "uwaga",
    "niebezpiecz",
    "diagnoz",
    "wszystko w porządku",
    "alarm",
  ],
  ko: ["해야", "위험", "진단", "경고", "주의"],
  nl: [
    "moet",
    "zou moeten",
    "waarschuwing",
    "gevaar",
    "diagnose",
    "alles goed",
    "alarm",
  ],
  "pt-BR": [
    "deveria",
    "você deve",
    "cuidado",
    "perigo",
    "diagnóstico",
    "tudo bem",
    "alerta",
  ],
  ru: [
    "следует",
    "должны",
    "опасн",
    "диагноз",
    "внимание",
    "всё хорошо",
    "тревог",
  ],
};

const NOW = new Date("2026-11-26T07:30:00Z");
const TODAY = "2026-11-26";

function base(locale: Locale, over: Partial<MorningInput>): MorningInput {
  return {
    locale,
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

/** Every sentence a locale can produce, built through the rules themselves. */
function renderAll(locale: Locale): string[] {
  const { t } = getServerTranslator(locale);
  const plainRange = t("daily.today.rangeWithUnit", {
    low: "110",
    high: "130",
    unit: "mmHg",
  });
  const sameHoursRange = t("daily.today.rangeAtThisTime", {
    range: t("daily.today.rangeWithUnit", {
      low: "4.8",
      high: "6.9",
      unit: "mmol/L",
    }),
  });
  const v = (over: Partial<TodayVital>): TodayVital => ({
    type: "BLOOD_PRESSURE_DIA",
    value: 150,
    low: 110,
    high: 130,
    direction: "above",
    daysAgo: 0,
    valueLabel: "150 mmHg",
    rangeLabel: plainRange,
    moduleKey: null,
    ...over,
  });
  const lead = (over: Partial<MorningInput>) =>
    buildMorningLead(base(locale, over), t).text;

  const out: string[] = [];
  for (const reason of [
    "bp_hypertensive",
    "bp_hypotensive",
    "glucose_hypo",
    "glucose_hyper",
  ] as const) {
    out.push(lead({ floor: { reason, valueLabel: "184/122 mmHg" } }));
  }
  for (const day of [1, 2, 3, 4, 6, 22, 25]) {
    out.push(lead({ restMode: { day } }));
  }
  // Rank 2: the three longest family names, then the counting form.
  const families = Object.keys(SIGNAL_FAMILIES);
  const byLength = [...families].sort(
    (a, b) =>
      t(`daily.lead.family.${b}`).length - t(`daily.lead.family.${a}`).length,
  );
  const typeOf = (family: string) =>
    (SIGNAL_FAMILIES as Record<string, readonly string[]>)[family][0];
  for (const illnessExplained of [false, true]) {
    for (const n of [2, 3, 4, 5, 6]) {
      out.push(
        lead({
          illnessExplained,
          vitals: byLength.slice(0, n).map((f) => v({ type: typeOf(f) })),
        }),
      );
    }
  }
  // Rank 3 and 8, every count form, for every vital by its own name. Only
  // glucose is compared with the same hours of earlier days, so only its
  // range carries "for this time of day".
  for (const type of VITALS_BASELINE_TYPES as string[]) {
    const rangeLabel = type === "BLOOD_GLUCOSE" ? sameHoursRange : plainRange;
    for (const direction of ["above", "below"] as const) {
      for (const extra of [0, 1, 2, 4, 5, 21]) {
        out.push(
          lead({
            vitals: [
              v({ type, direction, rangeLabel }),
              ...Array.from({ length: extra }, () =>
                v({ type: "WEIGHT", direction }),
              ),
            ],
          }),
        );
      }
    }
    out.push(lead({ vitals: [v({ type, direction: "in", rangeLabel })] }));
  }
  for (const n of [2, 3, 5, 21, 22]) {
    out.push(
      lead({
        vitals: Array.from({ length: n }, () => v({ direction: "in" })),
      }),
    );
  }
  out.push(lead({ sleepExpected: true, sleepPending: true }));
  for (const hours of [1, 2, 5, 14, 22, 47, 50, 70]) {
    out.push(
      lead({
        quiet: [
          {
            name: "Google Health",
            since: new Date(NOW.getTime() - hours * 3_600_000),
            sinceDay: TODAY,
          },
        ],
      }),
    );
  }
  for (const key of ["rhr", "hrv", "sleep", "respiratory", "mood"] as const) {
    out.push(
      lead({
        readiness: {
          score: 48,
          band: "red",
          fresh: true,
          asOfDay: TODAY,
          components: [{ key, value: 10, weight: 1 }],
        },
      }),
    );
  }
  for (const minutes of [300, 600]) {
    out.push(lead({ sleep: { minutes, usualMinutes: 450 } }));
    out.push(lead({ sleep: { minutes: 450, usualMinutes: 460 } }));
    out.push(lead({ sleep: { minutes, usualMinutes: null } }));
  }
  for (const doses of [1, 2, 3, 5, 21, 22]) {
    out.push(lead({ dosesToday: doses }));
    out.push(
      lead({ dosesToday: doses, visitToday: { timeLabel: "10:30 AM" } }),
    );
  }
  out.push(lead({ visitToday: { timeLabel: "10:30 AM" } }));
  out.push(lead({}));
  return out;
}

describe.each(locales.map((l) => [l]))("morning copy in %s", (locale) => {
  const sentences = renderAll(locale as Locale);

  it("renders every variant from the bundle", () => {
    expect(sentences.length).toBeGreaterThan(60);
    for (const s of sentences) {
      expect(s, s).not.toMatch(/[{}]/);
      expect(s, s).not.toMatch(/^daily\./);
    }
  });

  it("is one sentence of at most 120 characters, without '!'", () => {
    for (const s of sentences) {
      expect(s.length, s).toBeLessThanOrEqual(MAX);
      expect(s, s).not.toContain("!");
      expect(s, s).toMatch(/[.。]$/);
      // One terminator, at the end: nothing ends a sentence before it.
      expect(s.slice(0, -1), s).not.toMatch(/[.!?。]\s+[\p{Lu}\p{Lo}]/u);
    }
  });

  it("uses none of the blocked words", () => {
    for (const s of sentences) {
      const lower = s.toLocaleLowerCase();
      for (const word of BLOCKED[locale as Locale]) {
        expect(lower, `${s} contains "${word}"`).not.toContain(word);
      }
    }
  });
});

/**
 * A reading past a floor is one reading that reached it, not the state of a
 * day: "reached" in English, and the same in every language. "Der Blutdruck
 * lag in den letzten 24 Stunden bei 262" made a single after-meal reading
 * the level of the whole day.
 */
const REACHED: Record<Locale, RegExp> = {
  en: /\breached\b/,
  de: /\bstieg\b.*\bauf\b/,
  es: /\bllegó a\b/,
  fr: /\ba atteint\b/,
  it: /\bha raggiunto\b/,
  ko: /까지 올랐/,
  nl: /\bbereikte\b/,
  pl: /osiągnęł/,
  "pt-BR": /\bchegou a\b/,
  ru: /достигал/,
};

describe.each(locales.map((l) => [l]))("the floor sentence in %s", (locale) => {
  const { t } = getServerTranslator(locale as Locale);
  it.each(["bp_hypertensive", "glucose_hyper"] as const)(
    "%s says the reading reached the value",
    (reason) => {
      const text = buildMorningLead(
        base(locale as Locale, { floor: { reason, valueLabel: "262 mg/dL" } }),
        t,
      ).text;
      expect(text, text).toMatch(REACHED[locale as Locale]);
      expect(text, text).not.toMatch(/\blag\b.*\bbei\b/);
    },
  );
});

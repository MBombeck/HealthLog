/**
 * The morning read on `/`: one true sentence about the day and up to two
 * cards (last night, what is different today). The third card ("to do
 * today") is the digest's rail, served as the digest delivers it.
 *
 * Pure and deterministic. Every word comes from the person's own readings
 * through fixed rules; no model is reachable from here and nothing here is
 * handed to one (`morning-model-free-guard.test.ts`). The loader that gathers
 * the inputs is `morning-load.ts`.
 *
 * The sentence is chosen by rank: exactly one rule per state, the first that
 * holds wins.
 *
 *    0  a clinical safety floor was confirmed in the last 24 hours
 *    1  Rest mode is on
 *    2  two or more independent signals are outside their usual range today
 *    3  one value is outside (blood pressure alone, weight alone, ...), or a
 *       reading of the last 24 hours is past a safety floor that has not
 *       been confirmed yet (rank 8 would otherwise call it in range)
 *    4  sleep reaches the record, last night has not arrived yet, before
 *       local noon (after it, the night card still says so; the sentence
 *       moves on to what the day does hold)
 *    5  a source went quiet, on its first and second day only
 *    6  readiness is fresh and yellow or red
 *    7  last night is an hour or more off the usual
 *    8  today's values are all in range (counted), or an ordinary night is in
 *    9  no values today, but doses or a visit are planned
 *   10  nothing at all
 *
 * Every sentence is one sentence, a finding, never advice: no "should", no
 * exclamation mark, no general warning (`morning-copy.test.ts`). A rank that
 * cannot say something true for the case at hand does not hold.
 */
import type { Locale } from "@/lib/i18n/config";
import { pluralKey } from "@/lib/i18n/plural";
import { resolveIntlLocale } from "@/lib/format-locale";
import { formatDurationMinutes } from "@/lib/i18n/duration";
import { dayDiff } from "@/lib/cycle/day-math";
import {
  coincidentFamilies,
  type SignalFamily,
} from "@/lib/insights/derived/coincident-deviation";
import type { ModuleKey } from "@/lib/modules/registry";
import type { MorningFloor } from "@/lib/daily/morning-floor";
import { metricHref, pageHref } from "@/lib/links/hrefs";
import {
  currentVitals,
  type TodayRestMode,
  type TodaySleep,
  type TodayVital,
} from "@/lib/daily/today-overview";
import {
  notableNightSentence,
  ordinaryNightSentence,
  outsideVitals,
  SLEEP_CLOSE_DIFF_MINUTES,
  vitalLabel,
  vitalsInRangeSentence,
  vitalsOutsideSentence,
} from "@/lib/daily/lead-sentences";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

export type Band = "green" | "yellow" | "red";

export const MORNING_LEAD_KEYS = [
  "floor",
  "rest_mode",
  "coincident",
  "vital_outside",
  "sleep_pending",
  "source_quiet",
  "readiness",
  "night_notable",
  "in_range",
  "planned",
  "nothing",
] as const;

export type MorningLeadKey = (typeof MORNING_LEAD_KEYS)[number];

/** The rank of each rule; the index in {@link MORNING_LEAD_KEYS}. */
export function rankOf(key: MorningLeadKey): number {
  return MORNING_LEAD_KEYS.indexOf(key);
}

export const MORNING_CARD_KINDS = ["night", "today_different"] as const;
export type MorningCardKind = (typeof MORNING_CARD_KINDS)[number];

/** The most lines a card carries. */
export const MAX_CARD_LINES = 3;

/** Rank 4 speaks until this local hour; a night not in by noon is news no more. */
export const SLEEP_PENDING_LEAD_UNTIL_HOUR = 12;

/** Rank 5 speaks on the first and second quiet day only, then the rail does. */
export const QUIET_SENTENCE_MAX_DAY = 2;

/** A score a device computed, shown under its own name and never banded. */
export interface DeviceSourceValue {
  /** The `MeasurementSource` of the row ("WHOOP", "OURA", "POLAR", ...). */
  source: string;
  /** The vendor's own name for it ("WHOOP Recovery"), resolved server-side. */
  label: string;
  /** On the vendor's own scale (Polar 1 to 6, the rest 0 to 100). */
  value: number;
  scaleMax: number;
  measuredAt: string;
}

export interface DailyMorningRing {
  /** Null when the value is not fresh: no number from old readings. */
  score: number | null;
  /** Null when not fresh, and in Rest mode. */
  band: Band | null;
  fresh: boolean;
  /** The local day the value rests on, when there is one. */
  asOfDay: string | null;
}

export interface DailyMorningLine {
  text: string;
  href: string | null;
}

/**
 * The message key of each card's title, a closed set: the two cards the
 * morning carries and the "to do today" card a client builds from the digest.
 */
export const MORNING_CARD_TITLE_KEYS = {
  night: "daily.morningCard.title.night",
  today_different: "daily.morningCard.title.todayDifferent",
  to_do: "daily.morningCard.title.toDo",
} as const;

export type MorningCardTitleKey =
  (typeof MORNING_CARD_TITLE_KEYS)[keyof typeof MORNING_CARD_TITLE_KEYS];

export interface DailyMorningCard {
  kind: MorningCardKind;
  titleKey: MorningCardTitleKey;
  /** The title worded in the response language. */
  title: string;
  ring: DailyMorningRing | null;
  lines: DailyMorningLine[];
  sourceValues: DeviceSourceValue[];
  href: string;
}

export interface DailyMorningLead {
  rank: number;
  key: MorningLeadKey;
  text: string;
  /** The language the sentence is written in (always the response's). */
  language: string;
}

export interface DailyMorning {
  lead: DailyMorningLead;
  /** Night first, then what is different today; never padded. */
  cards: DailyMorningCard[];
  /**
   * The title of the third card, which clients build from the digest's rows
   * (medications fact, `worthALook`, cycle day), worded like the others.
   */
  toDo: { titleKey: MorningCardTitleKey; title: string };
  generatedAt: string;
}

/** A source the one stall rule (`sync-stall/quiet.ts`) holds quiet now. */
export interface MorningQuietSource {
  /** Display name ("WHOOP"). */
  name: string;
  /** The last delivery it went quiet after. */
  since: Date;
  /** The person's local day of that delivery, `YYYY-MM-DD`. */
  sinceDay: string;
}

export interface MorningReadinessComponent {
  key: "rhr" | "hrv" | "sleep" | "respiratory" | "mood";
  value: number | null;
  weight: number;
}

export interface MorningReadiness {
  score: number;
  band: Band;
  components: MorningReadinessComponent[];
  /** Every counted vital is from today and the night is last night. */
  fresh: boolean;
  asOfDay: string | null;
}

export interface MorningSleepScore {
  score: number;
  band: Band;
  /** Wake day of the night the score describes. */
  night: string;
}

export interface MorningInput {
  locale: Locale;
  modules: Partial<Record<ModuleKey, boolean>>;
  now: Date;
  /** The reader's local day, `YYYY-MM-DD`. */
  todayKey: string;
  /** The reader's local hour, 0 to 23. */
  localHour: number;
  floor: MorningFloor | null;
  /**
   * A reading of the last 24 hours past a safety floor that the engine has
   * not confirmed (no second reading yet). Not rank 0, but it keeps rank 8
   * from calling the day in range. Null when `floor` is set.
   */
  floorReading: MorningFloor | null;
  restMode: TodayRestMode | null;
  /** Every banded vital's standing, rendered in the reader's units. */
  vitals: readonly TodayVital[];
  /** The coincident engine's illness reframe (an episode is active). */
  illnessExplained: boolean;
  /** Sleep reaches this record at all (`isSleepExpected`). */
  sleepExpected: boolean;
  /** Sleep is expected and last night has not arrived (`digest.sleepPending`). */
  sleepPending: boolean;
  /** Last night, when it is in. */
  sleep: TodaySleep | null;
  /** The latest night on record, as a short date, for the pending card. */
  latestNightLabel: string | null;
  sleepScore: MorningSleepScore | null;
  sleepSourceValues: readonly DeviceSourceValue[];
  quiet: readonly MorningQuietSource[];
  readiness: MorningReadiness | null;
  recoverySourceValues: readonly DeviceSourceValue[];
  /** Doses scheduled for the local day. */
  dosesToday: number;
  /** The first visit planned for the local day, its start time rendered. */
  visitToday: { timeLabel: string } | null;
  /** Short local date of `readiness.asOfDay` ("Nov 24"), for "Last 81 on". */
  readinessAsOfLabel: string | null;
}

function moduleOn(
  modules: Partial<Record<ModuleKey, boolean>>,
  key: ModuleKey,
): boolean {
  return modules[key] !== false;
}

/** Upper-case the first letter, for a sentence that opens with a name. */
function capitalise(text: string, locale: Locale): string {
  if (text.length === 0) return text;
  return (
    text.charAt(0).toLocaleUpperCase(resolveIntlLocale(locale)) + text.slice(1)
  );
}

function familyName(t: Translate, family: SignalFamily): string {
  return t(`daily.lead.family.${family}`);
}

/** A list of names joined the way the language joins them ("a, b and c"). */
function joinNames(names: string[], locale: Locale): string {
  try {
    return new Intl.ListFormat(resolveIntlLocale(locale), {
      style: "long",
      type: "conjunction",
    }).format(names);
  } catch {
    return names.join(", ");
  }
}

/** The most families named in the rank-2 sentence before it counts instead. */
const MAX_NAMED_FAMILIES = 2;

function floorSentence(floor: MorningFloor, t: Translate): string {
  const key: Record<MorningFloor["reason"], string> = {
    bp_hypertensive: "bpHigh",
    bp_hypotensive: "bpLow",
    glucose_hypo: "glucoseLow",
    glucose_hypo_severe: "glucoseLow",
    glucose_hyper: "glucoseHigh",
  };
  return t(`daily.lead.floor.${key[floor.reason]}`, {
    value: floor.valueLabel,
  });
}

function restModeSentence(
  restMode: TodayRestMode,
  locale: Locale,
  t: Translate,
): string {
  // `day` is 1-based: day 1 began today, day 4 began three days ago.
  const days = Math.max(0, restMode.day - 1);
  if (days === 0) return t("daily.lead.restModeToday");
  return t(pluralKey("daily.lead.restMode", days, locale), { count: days });
}

function coincidentSentence(
  families: SignalFamily[],
  illness: boolean,
  locale: Locale,
  t: Translate,
): string {
  if (families.length > MAX_NAMED_FAMILIES) {
    const n = families.length;
    return t(
      illness
        ? pluralKey("daily.lead.coincidentIllnessMany", n, locale)
        : pluralKey("daily.lead.coincidentMany", n, locale),
      { count: n },
    );
  }
  const signals = joinNames(
    families.map((f) => familyName(t, f)),
    locale,
  );
  return capitalise(
    t(illness ? "daily.lead.coincidentIllness" : "daily.lead.coincident", {
      signals,
    }),
    locale,
  );
}

/** Whole days a source has been quiet on the reader's calendar (0 = today). */
function quietDays(todayKey: string, sinceDay: string): number {
  return dayDiff(todayKey, sinceDay);
}

/** The quiet source the sentence may name: on its first or second day. */
export function speakingQuietSource(
  quiet: readonly MorningQuietSource[],
  todayKey: string,
): MorningQuietSource | null {
  return (
    quiet.find(
      (q) => quietDays(todayKey, q.sinceDay) <= QUIET_SENTENCE_MAX_DAY,
    ) ?? null
  );
}

function quietSentence(
  q: MorningQuietSource,
  now: Date,
  locale: Locale,
  t: Translate,
): string {
  const hours = Math.max(
    1,
    Math.floor((now.getTime() - q.since.getTime()) / 3_600_000),
  );
  if (hours < 48) {
    return t(pluralKey("daily.lead.sourceQuietHours", hours, locale), {
      source: q.name,
      count: hours,
    });
  }
  const days = Math.floor(hours / 24);
  return t(pluralKey("daily.lead.sourceQuietDays", days, locale), {
    source: q.name,
    count: days,
  });
}

const CONTRIBUTOR_LABEL_KEY: Record<MorningReadinessComponent["key"], string> =
  {
    rhr: "insights.derived.composite.READINESS.component.rhr",
    hrv: "insights.derived.composite.READINESS.component.hrv",
    // The sleep contributor is the sleep score, and is called that.
    sleep: "insights.derived.composite.SLEEP_SCORE.title",
    respiratory: "insights.derived.composite.READINESS.component.respiratory",
    mood: "insights.derived.composite.READINESS.component.mood",
  };

/**
 * The contributors holding readiness back, largest weighted deduction first.
 * A contributor at 100 deducts nothing and is never named.
 */
export function heaviestDeductions(
  components: readonly MorningReadinessComponent[],
): MorningReadinessComponent[] {
  return components
    .filter((c) => c.value !== null && c.weight > 0 && c.value < 100)
    .sort(
      (a, b) =>
        b.weight * (100 - (b.value as number)) -
        a.weight * (100 - (a.value as number)),
    );
}

/** A contributor's name as it stands inside a sentence. */
function contributorInSentence(
  t: Translate,
  key: MorningReadinessComponent["key"],
  locale: Locale,
): string {
  const label = t(CONTRIBUTOR_LABEL_KEY[key]);
  // Nouns keep their capital in German; elsewhere a mid-sentence name is
  // lower case unless it is an abbreviation ("HRV").
  if (locale === "de" || label.length < 2) return label;
  const second = label.charAt(1);
  return second === second.toLocaleLowerCase()
    ? label.charAt(0).toLocaleLowerCase(resolveIntlLocale(locale)) +
        label.slice(1)
    : label;
}

function readinessSentence(
  readiness: MorningReadiness,
  locale: Locale,
  t: Translate,
): string | null {
  const heaviest = heaviestDeductions(readiness.components)[0];
  if (!heaviest) return null;
  return t("daily.lead.readiness", {
    score: Math.round(readiness.score),
    contributor: contributorInSentence(t, heaviest.key, locale),
  });
}

function plannedSentence(
  doses: number,
  visit: { timeLabel: string } | null,
  locale: Locale,
  t: Translate,
): string | null {
  if (doses > 0 && visit) {
    return t(pluralKey("daily.lead.plannedBoth", doses, locale), {
      count: doses,
      time: visit.timeLabel,
    });
  }
  if (doses > 0) {
    return t(pluralKey("daily.lead.plannedDoses", doses, locale), {
      count: doses,
    });
  }
  if (visit) return t("daily.lead.plannedVisit", { time: visit.timeLabel });
  return null;
}

/** Everything the rules read, narrowed to what the modules let speak. */
interface Facts {
  vitals: TodayVital[];
  outside: TodayVital[];
  families: SignalFamily[];
  sleep: TodaySleep | null;
  sleepPending: boolean;
  restMode: TodayRestMode | null;
  readiness: MorningReadiness | null;
  quiet: MorningQuietSource | null;
}

function gather(input: MorningInput): Facts {
  const sleepOn = moduleOn(input.modules, "sleep");
  const vitals = currentVitals(input);
  const outside = outsideVitals(vitals);
  return {
    vitals,
    outside,
    families: coincidentFamilies(outside),
    sleep: sleepOn ? input.sleep : null,
    sleepPending: sleepOn && input.sleepPending,
    restMode: moduleOn(input.modules, "illness") ? input.restMode : null,
    readiness: moduleOn(input.modules, "recovery") ? input.readiness : null,
    quiet: speakingQuietSource(input.quiet, input.todayKey),
  };
}

/** The one sentence, by rank. Exported for the rule table test. */
export function buildMorningLead(
  input: MorningInput,
  t: Translate,
): DailyMorningLead {
  const facts = gather(input);
  const lead = (key: MorningLeadKey, text: string): DailyMorningLead => ({
    rank: rankOf(key),
    key,
    text,
    language: input.locale,
  });
  const { locale } = input;

  if (input.floor) return lead("floor", floorSentence(input.floor, t));
  if (facts.restMode) {
    return lead("rest_mode", restModeSentence(facts.restMode, locale, t));
  }
  if (facts.families.length >= 2) {
    return lead(
      "coincident",
      coincidentSentence(facts.families, input.illnessExplained, locale, t),
    );
  }
  if (facts.outside.length > 0) {
    // The furthest out by name. Any others are fewer than two independent
    // signals (the other half of a blood pressure, weight beside glucose) and
    // stand in the "today different" card, which lists every one.
    return lead(
      "vital_outside",
      vitalsOutsideSentence(facts.outside.slice(0, 1), locale, t),
    );
  }
  // A single reading past a safety floor is in a personal range that sits
  // that high, so the counted vitals call it usual; the day is not "all in
  // range" while it stands.
  if (input.floorReading) {
    return lead("vital_outside", floorSentence(input.floorReading, t));
  }
  if (facts.sleepPending && input.localHour < SLEEP_PENDING_LEAD_UNTIL_HOUR) {
    return lead("sleep_pending", t("daily.lead.sleepPending"));
  }
  if (facts.quiet) {
    return lead(
      "source_quiet",
      quietSentence(facts.quiet, input.now, locale, t),
    );
  }
  if (
    facts.readiness?.fresh &&
    (facts.readiness.band === "yellow" || facts.readiness.band === "red")
  ) {
    const text = readinessSentence(facts.readiness, locale, t);
    if (text) return lead("readiness", text);
  }
  const notable = notableNightSentence(facts.sleep, t);
  if (notable) return lead("night_notable", notable);
  const inRange =
    vitalsInRangeSentence(facts.vitals, locale, t) ??
    ordinaryNightSentence(facts.sleep, t);
  if (inRange) return lead("in_range", inRange);
  const planned = plannedSentence(
    moduleOn(input.modules, "medications") ? input.dosesToday : 0,
    input.visitToday,
    locale,
    t,
  );
  if (planned) return lead("planned", planned);
  return lead("nothing", t("daily.lead.nothingYet"));
}

function cardTitle(
  kind: keyof typeof MORNING_CARD_TITLE_KEYS,
  t: Translate,
): { titleKey: MorningCardTitleKey; title: string } {
  const titleKey = MORNING_CARD_TITLE_KEYS[kind];
  return { titleKey, title: t(titleKey) };
}

function sleepLine(sleep: TodaySleep, t: Translate): string {
  const params = {
    duration: formatDurationMinutes(Math.round(sleep.minutes), t),
  };
  if (sleep.usualMinutes === null) {
    return t("daily.todayFact.sleep.plain", params);
  }
  const diff = Math.round(sleep.minutes - sleep.usualMinutes);
  if (Math.abs(diff) <= SLEEP_CLOSE_DIFF_MINUTES) {
    return t("daily.todayFact.sleep.usual", params);
  }
  return t(`daily.todayFact.sleep.${diff > 0 ? "more" : "less"}`, {
    ...params,
    diff: formatDurationMinutes(Math.abs(diff), t),
  });
}

function nightCard(
  input: MorningInput,
  facts: Facts,
  t: Translate,
): DailyMorningCard | null {
  if (!moduleOn(input.modules, "sleep")) return null;
  if (!input.sleepExpected && !facts.sleep) return null;
  const score = input.sleepScore;
  const lines: DailyMorningLine[] = [];
  if (facts.sleep) {
    lines.push({ text: sleepLine(facts.sleep, t), href: null });
  } else {
    lines.push({ text: t("daily.morningCard.nightPending"), href: null });
    if (input.latestNightLabel) {
      lines.push({
        text: t("daily.morningCard.latestNight", {
          date: input.latestNightLabel,
        }),
        href: null,
      });
    }
  }
  return {
    kind: "night",
    ...cardTitle("night", t),
    // A ring only for last night; an older night's score is not this morning's.
    ring:
      score && lastNightScored(input)
        ? {
            score: Math.round(score.score),
            band: score.band,
            fresh: true,
            asOfDay: score.night,
          }
        : null,
    lines: lines.slice(0, MAX_CARD_LINES),
    sourceValues: [...input.sleepSourceValues],
    href: metricHref("sleep_score") ?? pageHref("insights"),
  };
}

/** Whether the night card carries last night's sleep score ring. */
function lastNightScored(input: MorningInput): boolean {
  return (
    input.modules.sleep !== false &&
    input.sleepScore !== null &&
    input.sleepScore.night === input.todayKey
  );
}

function todayDifferentCard(
  input: MorningInput,
  facts: Facts,
  t: Translate,
): DailyMorningCard | null {
  const sourceValues = [...input.recoverySourceValues];
  if (facts.outside.length > 0) {
    return {
      kind: "today_different",
      ...cardTitle("today_different", t),
      ring: null,
      lines: facts.outside.slice(0, MAX_CARD_LINES).map((v) => ({
        text: t("daily.morningCard.vitalOutside", {
          metric: vitalLabel(t, v.type),
          value: v.valueLabel,
          range: v.rangeLabel,
        }),
        href: null,
      })),
      sourceValues,
      // The signal card on Insights, with the possible reasons as the engine
      // words them.
      href: pageHref("insights"),
    };
  }
  const readiness = facts.readiness;
  if (readiness) {
    const lines: DailyMorningLine[] = [];
    let ring: DailyMorningRing;
    if (readiness.fresh) {
      const banded = facts.restMode === null;
      ring = {
        score: Math.round(readiness.score),
        band: banded ? readiness.band : null,
        fresh: true,
        asOfDay: readiness.asOfDay,
      };
      if (banded) {
        lines.push({
          text: t(`daily.morningCard.readinessBand.${readiness.band}`),
          href: null,
        });
      }
      // The night card beside it already shows last night's sleep score, so
      // the sleep contributor is not named twice; the next deduction is.
      const nightShown = lastNightScored(input);
      const named = heaviestDeductions(readiness.components).filter(
        (c) => !(nightShown && c.key === "sleep"),
      );
      for (const c of named.slice(0, 2)) {
        lines.push({
          text: t("daily.morningCard.contributor", {
            name: t(CONTRIBUTOR_LABEL_KEY[c.key]),
            value: Math.round(c.value as number),
          }),
          href: null,
        });
      }
    } else {
      // Not fresh: no number, no band. The last value is named as past.
      ring = {
        score: null,
        band: null,
        fresh: false,
        asOfDay: readiness.asOfDay,
      };
      if (input.readinessAsOfLabel) {
        lines.push({
          text: t("daily.morningCard.readinessLast", {
            score: Math.round(readiness.score),
            date: input.readinessAsOfLabel,
          }),
          href: null,
        });
      }
    }
    return {
      kind: "today_different",
      ...cardTitle("today_different", t),
      ring,
      lines: lines.slice(0, MAX_CARD_LINES),
      sourceValues,
      href: metricHref("readiness") ?? pageHref("insights"),
    };
  }
  if (sourceValues.length > 0) {
    return {
      kind: "today_different",
      ...cardTitle("today_different", t),
      ring: null,
      lines: [],
      sourceValues,
      href: metricHref("recovery") ?? pageHref("insights"),
    };
  }
  return null;
}

/** The morning read: the sentence and the cards, from one set of facts. */
export function buildDailyMorning(
  input: MorningInput,
  t: Translate,
): DailyMorning {
  const facts = gather(input);
  const cards = [
    nightCard(input, facts, t),
    todayDifferentCard(input, facts, t),
  ].filter((c): c is DailyMorningCard => c !== null);
  return {
    lead: buildMorningLead(input, t),
    cards,
    toDo: cardTitle("to_do", t),
    generatedAt: input.now.toISOString(),
  };
}

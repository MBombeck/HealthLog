/**
 * The Today overview: the hero's lead line and its short list of facts about
 * the day, composed from data the digest already gathered.
 *
 * Pure and deterministic, like the rest of the digest spine. It never calls a
 * model; AI text reaches it only as the already-cached reaction line and
 * briefing, and only while their capabilities are available (the caller has
 * already nulled them otherwise). Everything a person without any AI provider
 * sees here comes from their own readings.
 *
 * Three rules hold for every line this file writes:
 *
 *   - A fact is a statement. No line asks the person to do anything; the
 *     worth-a-look rail is the one place on the hero allowed to.
 *   - A fact about a switched-off module does not exist. Gating happens here,
 *     on the server, never in a client.
 *   - Nothing is said twice. When the lead line is built from a fact, that
 *     fact leaves the list; an appointment already on the rail is not repeated
 *     under Today.
 */
import type { DailyBriefing } from "@/lib/ai/schema";
import type { CyclePhase } from "@/lib/cycle/types";
import type { MedsTodayBlock } from "@/lib/dashboard/meds-today";
import type { Locale } from "@/lib/i18n/config";
import { pluralKey } from "@/lib/i18n/plural";
import { formatDurationMinutes } from "@/lib/i18n/duration";
import { isCurrentForTodayClaim } from "@/lib/insights/measurement-freshness";
import type { ModuleKey } from "@/lib/modules/registry";
import type { PriorityItem } from "@/lib/daily/priority-item";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/** The most facts the overview ever carries (a wide screen shows them all). */
export const MAX_TODAY_FACTS = 5;

/**
 * The most facts a narrow screen shows. The list is already in priority
 * order, so a phone simply shows its head; the fifth line is never a
 * different fact on a phone, only an absent one.
 */
export const MAX_TODAY_FACTS_NARROW = 4;

export const TODAY_FACT_KINDS = [
  "rest_mode",
  "medications",
  "appointment",
  "sleep",
  "vitals",
  "cycle",
] as const;

export type TodayFactKind = (typeof TODAY_FACT_KINDS)[number];

/** One line under "Today": a label, a value, and where it leads. */
export interface TodayFact {
  kind: TodayFactKind;
  /** Localised label, resolved on the server. */
  label: string;
  /** Localised value, resolved on the server. */
  value: string;
  /** The page the fact belongs to. */
  href: string;
  /** The module that admitted the fact; absent for core data. */
  moduleKey?: ModuleKey;
}

export const TODAY_LEAD_SOURCES = ["reaction", "briefing", "signal"] as const;

export type TodayLeadSource = (typeof TODAY_LEAD_SOURCES)[number];

/**
 * The hero's lead line, resolved. `reaction` and `briefing` are cached model
 * text; `signal` is the deterministic sentence built from the day's strongest
 * signal, which is what every account without AI reads.
 */
export interface TodayLead {
  text: string;
  source: TodayLeadSource;
}

/**
 * One vital's standing against its personal band, as the coincident-deviation
 * engine computed it, with the two labels the copy needs already rendered in
 * the reader's units.
 */
export interface TodayVital {
  type: string;
  /** Canonical value; only compared, never printed. */
  value: number;
  low: number;
  high: number;
  direction: "above" | "below" | "in";
  /** Whole days between the reading and the reader's local today. */
  daysAgo: number;
  /** The reading in the reader's units, unit included ("61 bpm"). */
  valueLabel: string;
  /** The band in the reader's units ("52 to 57 bpm"). */
  rangeLabel: string;
  /** The module the vital belongs to, or null for core vitals. */
  moduleKey: ModuleKey | null;
}

/** Last night's sleep, when it is in the record. */
export interface TodaySleep {
  /** Time asleep last night, in minutes. */
  minutes: number;
  /** The person's own trailing average, in minutes, when there is one. */
  usualMinutes: number | null;
}

/** The current illness episode, when Rest Mode is on. */
export interface TodayRestMode {
  /** 1-based day of the episode on the reader's own calendar. */
  day: number;
}

/** Today's place in the cycle, when the cycle module knows it. */
export interface TodayCycle {
  dayOfCycle: number;
  /** Withheld (null) while the engine is still learning the cycle. */
  phase: CyclePhase | null;
}

/** A booked visit, with its start time rendered for the reader. */
export interface TodayVisit {
  id: string;
  /** 0 today, 1 tomorrow, 2 the day after (profile timezone). */
  dayOffset: number;
  /** Start time in the reader's zone and clock ("09:30"). */
  timeLabel: string;
  /** Practitioner or visit kind, already resolved. */
  what: string;
}

export interface TodayOverviewInput {
  locale: Locale;
  modules: Partial<Record<ModuleKey, boolean>>;
  /** Reaction line for today's newest arrival, already capability-gated. */
  reactionLine: string | null;
  /** The cached briefing, already capability-gated. */
  briefing: DailyBriefing | null;
  /** The number inside the ring, so a lead never repeats it. */
  scoreValue: number | null;
  medsToday: MedsTodayBlock;
  visits: readonly TodayVisit[];
  /** The rail as it will be published, for the appointment de-duplication. */
  rail: readonly PriorityItem[];
  restMode: TodayRestMode | null;
  sleep: TodaySleep | null;
  vitals: readonly TodayVital[];
  cycle: TodayCycle | null;
}

export interface TodayOverview {
  lead: TodayLead | null;
  today: TodayFact[];
  /** The first substantive briefing sentence, for `briefingLead`. */
  briefingLead: string | null;
}

/** Trim a lead sentence to a lock-screen-friendly length. */
const MAX_LEAD_LENGTH = 160;

/**
 * How far last night may sit from the person's usual before the night itself
 * becomes the day's strongest signal. An hour is a difference anyone notices
 * the next day; less than that is ordinary variation and stays a fact.
 */
export const SLEEP_NOTABLE_DIFF_MINUTES = 60;

/** Within this many minutes of the usual, the night reads as "close to". */
export const SLEEP_CLOSE_DIFF_MINUTES = 20;

function moduleOn(
  modules: Partial<Record<ModuleKey, boolean>>,
  key: ModuleKey,
): boolean {
  return modules[key] !== false;
}

/** Split prose into sentences, keeping each one's own punctuation. */
function sentences(text: string): string[] {
  return (
    text
      .trim()
      .match(/(?:[^.!?]|[.!?](?=\S))+(?:[.!?]+|$)/g)
      ?.map((s) => s.trim())
      .filter((s) => s.length > 0) ?? []
  );
}

/**
 * Opening words of a salutation, in every shipped language. Matched only at
 * the very start of a sentence, and only on a sentence with no number in it:
 * "Good morning, your resting heart rate is 52." carries content and stays.
 */
const GREETING_START =
  /^(good\s+(morning|afternoon|evening|night|day)|hello|hi|hey|welcome|guten\s+(morgen|tag|abend)|hallo|moin|servus|willkommen|buen[oa]s?\s+(d[ií]as|tardes|noches)|hola|bienvenid[oa]|bonjour|bonsoir|salut|bienvenue|buongiorno|buon\s+pomeriggio|buonasera|ciao|benvenut[oa]|dzie[nń]\s+dobry|dobry\s+wiecz[oó]r|cze[sś][cć]|witaj|witamy|좋은\s*(아침|저녁|오후)|안녕하세요|안녕)(?![\p{L}])/iu;

/** Short sentence without a number, below which nothing is said. */
const MIN_CONTENT_WORDS = 4;

/**
 * Whether a sentence is a greeting rather than a statement about the day.
 *
 * The briefing is model text and often opens with "Good morning." — which,
 * taken as the first sentence, became the whole lead and pushed the sentence
 * that had something to say out of view. A sentence carrying a number always
 * counts as content. Otherwise it is a greeting when it opens with one, or
 * when it is too short to say anything (an exclamation, a sign-off).
 */
export function isGreetingOnly(sentence: string): boolean {
  const s = sentence.trim();
  if (s.length === 0) return true;
  if (/\d/.test(s)) return false;
  if (GREETING_START.test(s)) return true;
  const words = s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.length < MIN_CONTENT_WORDS;
}

/**
 * Words that name the health score in every shipped language, and the
 * "out of 100" forms. A sentence repeats the ring only when it talks about
 * the score; a figure that merely shares its digits ("7 h 52 min" next to a
 * score of 52) is content.
 */
const SCORE_CONTEXT =
  /(?<![\p{L}])(scores?|gesundheitsscore|punteggio|puntuaci[oó]n|puntaje|wynik(u)?)(?![\p{L}])|점수|\/\s*100(?!\d)|(out of|von|sur|su|de|na|z)\s+100(?!\d)/iu;

/** A unit right after a number makes it a measurement, not the score. */
const UNIT_AFTER =
  /^\s*(h|hrs?|hours?|min(s|utes?|uten?|utos?|uti|ut)?|sec|s|ms|bpm|%|kg|lbs?|mmhg|mg|mmol|cm|km|m|steps?|schritte|std|stunden?|horas?|heures?|ore|godz(in)?|시간|분|°)(?![\p{L}])/iu;

/** Whether a sentence repeats the number the ring already shows. */
function repeatsScore(sentence: string, score: number | null): boolean {
  if (score === null) return false;
  if (!SCORE_CONTEXT.test(sentence)) return false;
  const shown = String(Math.round(score));
  // The number on its own: not part of a longer figure, a decimal or a time,
  // and not followed by a unit.
  const standalone = new RegExp(`(?<![\\d.,:])${shown}(?![\\d]|[.,:]\\d)`, "g");
  for (const match of sentence.matchAll(standalone)) {
    const after = sentence.slice((match.index ?? 0) + shown.length);
    if (!UNIT_AFTER.test(after)) return true;
  }
  return false;
}

function clampLead(sentence: string): string {
  return sentence.length > MAX_LEAD_LENGTH
    ? `${sentence.slice(0, MAX_LEAD_LENGTH - 1).trimEnd()}…`
    : sentence;
}

/**
 * The first sentence of a paragraph that says something: not a greeting, and
 * not a restatement of the score inside the ring. Null when no sentence
 * qualifies, so the caller falls through to the next source rather than
 * showing filler.
 */
export function firstSubstantiveSentence(
  paragraph: string | null | undefined,
  score: number | null,
): string | null {
  if (!paragraph) return null;
  for (const sentence of sentences(paragraph)) {
    if (isGreetingOnly(sentence)) continue;
    if (repeatsScore(sentence, score)) continue;
    return clampLead(sentence);
  }
  return null;
}

/**
 * The model's reaction line, minus any greeting or score sentence. Unlike the
 * briefing it may keep more than one sentence: it is written to be read whole.
 */
function cleanReactionLine(
  line: string | null,
  score: number | null,
): string | null {
  if (!line) return null;
  const kept = sentences(line).filter(
    (s) => !isGreetingOnly(s) && !repeatsScore(s, score),
  );
  const text = kept.join(" ").replace(/\s+/g, " ").trim();
  return text.length > 0 ? clampLead(text) : null;
}

/** Vitals that may speak about today: module on, reading current. */
function currentVitals(input: TodayOverviewInput): TodayVital[] {
  return input.vitals.filter(
    (v) =>
      isCurrentForTodayClaim(v.daysAgo) &&
      (v.moduleKey === null || moduleOn(input.modules, v.moduleKey)),
  );
}

/** How far outside its band a vital sits, in band widths. */
function outsideBy(v: TodayVital): number {
  const width = Math.max(v.high - v.low, Number.EPSILON);
  if (v.direction === "above") return (v.value - v.high) / width;
  if (v.direction === "below") return (v.low - v.value) / width;
  return 0;
}

function vitalLabel(t: Translate, type: string): string {
  const key = `daily.today.vital.${type}`;
  const label = t(key);
  return label === key ? t("daily.today.vital.generic") : label;
}

function sleepDiff(sleep: TodaySleep): number | null {
  if (sleep.usualMinutes === null) return null;
  return Math.round(sleep.minutes - sleep.usualMinutes);
}

function duration(minutes: number, t: Translate): string {
  return formatDurationMinutes(Math.round(minutes), t);
}

interface SignalLead {
  text: string;
  consumes: TodayFactKind;
}

/**
 * The deterministic lead: one sentence about the day's strongest signal,
 * built from numbers the server already holds. In order:
 *
 *   1. a vital outside its personal range (the furthest out leads);
 *   2. a night at least an hour off the person's usual;
 *   3. every recent vital inside its range;
 *   4. an ordinary night.
 *
 * Null when none of them holds; the overview then carries the facts alone,
 * and never a filler sentence.
 */
function signalLead(
  input: TodayOverviewInput,
  sleep: TodaySleep | null,
  t: Translate,
): SignalLead | null {
  const vitals = currentVitals(input);
  const outside = vitals
    .filter((v) => v.direction !== "in")
    .sort((a, b) => outsideBy(b) - outsideBy(a));

  if (outside.length > 0) {
    const v = outside[0];
    const params = {
      metric: vitalLabel(t, v.type),
      value: v.valueLabel,
      range: v.rangeLabel,
    };
    const text =
      outside.length === 1
        ? t(`daily.lead.vitalOutside.${v.direction}`, params)
        : t(
            pluralKey(
              `daily.lead.vitalsOutside.${v.direction}`,
              outside.length - 1,
              input.locale,
            ),
            { ...params, count: outside.length - 1 },
          );
    return { text, consumes: "vitals" };
  }

  const diff = sleep ? sleepDiff(sleep) : null;
  if (sleep && diff !== null && Math.abs(diff) >= SLEEP_NOTABLE_DIFF_MINUTES) {
    return {
      text: t(`daily.lead.sleep.${diff > 0 ? "more" : "less"}`, {
        duration: duration(sleep.minutes, t),
        diff: duration(Math.abs(diff), t),
      }),
      consumes: "sleep",
    };
  }

  if (vitals.length >= 2) {
    return {
      text: t(
        pluralKey("daily.lead.vitalsInRange", vitals.length, input.locale),
        { count: vitals.length },
      ),
      consumes: "vitals",
    };
  }
  if (vitals.length === 1) {
    const v = vitals[0];
    return {
      text: t("daily.lead.vitalInRange", {
        metric: vitalLabel(t, v.type),
        value: v.valueLabel,
        range: v.rangeLabel,
      }),
      consumes: "vitals",
    };
  }

  if (sleep) {
    return {
      text:
        diff !== null
          ? t("daily.lead.sleep.usual", {
              duration: duration(sleep.minutes, t),
            })
          : t("daily.lead.sleep.plain", {
              duration: duration(sleep.minutes, t),
            }),
      consumes: "sleep",
    };
  }
  return null;
}

function restModeFact(
  input: TodayOverviewInput,
  t: Translate,
): TodayFact | null {
  if (!input.restMode || !moduleOn(input.modules, "illness")) return null;
  return {
    kind: "rest_mode",
    label: t("daily.todayFact.restMode.label"),
    value: t("daily.todayFact.restMode.value", { day: input.restMode.day }),
    href: "/illness",
    moduleKey: "illness",
  };
}

function medicationsFact(
  input: TodayOverviewInput,
  t: Translate,
): TodayFact | null {
  if (!moduleOn(input.modules, "medications")) return null;
  const { scheduledToday, takenToday } = input.medsToday;
  if (scheduledToday <= 0) return null;
  return {
    kind: "medications",
    label: t("daily.todayFact.medications.label"),
    value: t("daily.todayFact.medications.value", {
      taken: Math.min(takenToday, scheduledToday),
      scheduled: scheduledToday,
    }),
    href: "/medications",
    moduleKey: "medications",
  };
}

/**
 * The next appointment today or tomorrow, and nothing further out.
 *
 * Skipped when the rail already carries an appointment item: the rail item
 * stays (it is the published contract every client reads, and it keeps its
 * place under the cap for a visit today), and one card does not name the same
 * visit twice.
 */
function appointmentFact(
  input: TodayOverviewInput,
  t: Translate,
): TodayFact | null {
  if (input.rail.some((item) => item.kind === "upcoming_visit")) return null;
  const visit = [...input.visits]
    .filter((v) => v.dayOffset >= 0 && v.dayOffset <= 1)
    .sort((a, b) => a.dayOffset - b.dayOffset)[0];
  if (!visit) return null;
  const sameDay = input.visits.filter((v) => v.dayOffset === visit.dayOffset);
  const others = sameDay.length - 1;
  const what = others > 0 ? `${visit.what} +${others}` : visit.what;
  return {
    kind: "appointment",
    label: t("daily.todayFact.appointment.label"),
    value: t(
      visit.dayOffset <= 0
        ? "daily.todayFact.appointment.today"
        : "daily.todayFact.appointment.tomorrow",
      { time: visit.timeLabel, what },
    ),
    href: "/checkups",
  };
}

function sleepFact(sleep: TodaySleep | null, t: Translate): TodayFact | null {
  if (!sleep) return null;
  const diff = sleepDiff(sleep);
  const params = { duration: duration(sleep.minutes, t) };
  const value =
    diff === null
      ? t("daily.todayFact.sleep.plain", params)
      : Math.abs(diff) <= SLEEP_CLOSE_DIFF_MINUTES
        ? t("daily.todayFact.sleep.usual", params)
        : t(`daily.todayFact.sleep.${diff > 0 ? "more" : "less"}`, {
            ...params,
            diff: duration(Math.abs(diff), t),
          });
  return {
    kind: "sleep",
    label: t("daily.todayFact.sleep.label"),
    value,
    href: "/insights/sleep",
    moduleKey: "sleep",
  };
}

function vitalsFact(input: TodayOverviewInput, t: Translate): TodayFact | null {
  const vitals = currentVitals(input);
  if (vitals.length === 0) return null;
  const outside = vitals
    .filter((v) => v.direction !== "in")
    .sort((a, b) => outsideBy(b) - outsideBy(a));
  let value: string;
  if (outside.length === 0) {
    value = t(
      pluralKey("daily.todayFact.vitals.allIn", vitals.length, input.locale),
      { count: vitals.length },
    );
  } else if (outside.length === 1) {
    value = t(`daily.todayFact.vitals.oneOut.${outside[0].direction}`, {
      metric: vitalLabel(t, outside[0].type),
    });
  } else {
    value = t("daily.todayFact.vitals.someOut", {
      count: outside.length,
      total: vitals.length,
    });
  }
  return {
    kind: "vitals",
    label: t("daily.todayFact.vitals.label"),
    value,
    href: "/insights",
  };
}

function cycleFact(input: TodayOverviewInput, t: Translate): TodayFact | null {
  if (!input.cycle || !moduleOn(input.modules, "cycle")) return null;
  return {
    kind: "cycle",
    label: t("daily.todayFact.cycle.label"),
    value: input.cycle.phase
      ? t("daily.todayFact.cycle.value", {
          day: input.cycle.dayOfCycle,
          phase: t(`cycle.phase.${input.cycle.phase}`),
        })
      : t("daily.todayFact.cycle.dayOnly", { day: input.cycle.dayOfCycle }),
    href: "/cycle",
    moduleKey: "cycle",
  };
}

/**
 * Compose the lead line and the Today facts.
 *
 * Lead precedence, warmest first: the reaction line to something that landed
 * today, then the first briefing sentence with content, then the briefing's
 * top-signal headline, then the deterministic sentence from the strongest
 * signal. The first two are model text and only reach this function while
 * their capabilities are available; the deterministic sentence is what makes
 * the card whole without them.
 *
 * Facts follow a fixed priority (Rest Mode, medications, an appointment today
 * or tomorrow, last night, vitals, cycle) and are capped at
 * {@link MAX_TODAY_FACTS}. The list is never padded: a quiet account gets as
 * many lines as it has facts, and none at all is a valid answer.
 */
export function buildTodayOverview(
  input: TodayOverviewInput,
  t: Translate,
): TodayOverview {
  const sleep = moduleOn(input.modules, "sleep") ? input.sleep : null;

  const briefingLead = firstSubstantiveSentence(
    input.briefing?.paragraph,
    input.scoreValue,
  );
  const reaction = cleanReactionLine(input.reactionLine, input.scoreValue);
  const headline = input.briefing?.signalsOfDay?.[0]?.headline?.trim() || null;

  let lead: TodayLead | null = null;
  let consumed: TodayFactKind | null = null;
  if (reaction) {
    lead = { text: reaction, source: "reaction" };
  } else if (briefingLead) {
    lead = { text: briefingLead, source: "briefing" };
  } else if (headline && !repeatsScore(headline, input.scoreValue)) {
    lead = { text: clampLead(headline), source: "briefing" };
  } else {
    const signal = signalLead(input, sleep, t);
    if (signal) {
      lead = { text: signal.text, source: "signal" };
      consumed = signal.consumes;
    }
  }

  const facts = [
    restModeFact(input, t),
    medicationsFact(input, t),
    appointmentFact(input, t),
    sleepFact(sleep, t),
    vitalsFact(input, t),
    cycleFact(input, t),
  ].filter(
    (fact): fact is TodayFact => fact !== null && fact.kind !== consumed,
  );

  return {
    lead,
    today: facts.slice(0, MAX_TODAY_FACTS),
    briefingLead,
  };
}

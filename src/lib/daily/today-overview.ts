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
import type { DailyBriefing, DailyBriefingSignal } from "@/lib/ai/schema";
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

/**
 * The muted line under the lead: the briefing's top signal, minus whatever
 * the lead already says. `headline` is null when the lead covers the signal's
 * metric; the line is absent altogether when nothing is left.
 */
export interface TodaySignalLine {
  headline: string | null;
  delta: string | null;
}

export interface TodayOverview {
  lead: TodayLead | null;
  /** The supporting line under an AI lead, already de-duplicated. */
  signalLine: TodaySignalLine | null;
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

/** Whether a sentence (or a run of them) fits the lead's length budget. */
function fitsLead(text: string): boolean {
  return text.length <= MAX_LEAD_LENGTH;
}

/**
 * Shorten text that does not fit, at a word boundary, as the last resort.
 *
 * Slicing at a character count cut words in half ("…sleep landed r…"). The
 * cut now falls on the last space inside the budget, and trailing clause
 * punctuation goes with it, so what is left ends on a whole word.
 */
function shortenAtWord(text: string): string {
  if (fitsLead(text)) return text;
  // One character of the budget goes to the ellipsis itself, so the kept
  // head is at most MAX - 1 long: a space at that index still ends a whole
  // word, and text with no space at all is cut hard one short of the budget.
  const space = text.slice(0, MAX_LEAD_LENGTH).lastIndexOf(" ");
  const head = (
    space > 0 ? text.slice(0, space) : text.slice(0, MAX_LEAD_LENGTH - 1)
  )
    .trimEnd()
    .replace(/[\s,;:–—-]+$/u, "");
  return `${head}…`;
}

/** The sentences of a paragraph that say something, in order. */
function substantiveSentences(
  paragraph: string | null | undefined,
  score: number | null,
): string[] {
  if (!paragraph) return [];
  return sentences(paragraph).filter(
    (s) => !isGreetingOnly(s) && !repeatsScore(s, score),
  );
}

/**
 * The first sentence of a paragraph that says something: not a greeting, and
 * not a restatement of the score inside the ring. Null when no sentence
 * qualifies, so the caller falls through to the next source rather than
 * showing filler. A sentence past the length budget is shortened at a word
 * boundary; it feeds `briefingLead` and the push line, which have no other
 * source to fall to.
 */
export function firstSubstantiveSentence(
  paragraph: string | null | undefined,
  score: number | null,
): string | null {
  const first = substantiveSentences(paragraph, score)[0];
  return first ? shortenAtWord(first) : null;
}

/**
 * The model's reaction line, minus any greeting or score sentence. Unlike the
 * briefing it may keep more than one sentence: it is written to be read whole.
 * It keeps whole sentences from the start while they fit the budget, and is
 * null when even the first one does not, so the lead falls to a source that
 * can be shown complete.
 */
function cleanReactionLine(
  line: string | null,
  score: number | null,
): string | null {
  if (!line) return null;
  let text = "";
  for (const sentence of substantiveSentences(line, score)) {
    const next = text ? `${text} ${sentence}` : sentence;
    if (!fitsLead(next.replace(/\s+/g, " "))) break;
    text = next.replace(/\s+/g, " ");
  }
  return text.length > 0 ? text : null;
}

/** Lowercase letters and digits only, for a wording-insensitive compare. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Whether `text` already says what `phrase` says, wording aside. */
function restates(text: string, phrase: string): boolean {
  const p = normalise(phrase);
  return p.length > 0 && normalise(text).includes(p);
}

/**
 * A term that must start a word: `stem` lets an inflection follow it
 * ("Blutdrucks", "tętna"), `word` must end where the word ends. Unicode-aware
 * on both sides, since `\b` only knows ASCII letters and would split "spał".
 * Without the boundaries a fragment inside another word named the metric:
 * "risen" read as the Polish "sen" (sleep), "impulse" as "puls".
 */
const START = "(?<![\\p{L}\\p{N}])";
const END = "(?![\\p{L}\\p{N}])";
const stem = (...terms: string[]) => terms.map((x) => `${START}${x}`);
const word = (...terms: string[]) => terms.map((x) => `${START}${x}${END}`);
/** Hangul has no word boundary to lean on: the term carries its particle. */
const hangul = (...terms: string[]) => terms;
const terms = (...parts: string[][]) =>
  new RegExp(parts.flat().join("|"), "iu");

const WEIGHT_TERMS = terms(
  stem("weigh", "gewicht"),
  word("peso", "pesos", "poids", "wag[aięe]", "wadze"),
  hangul("체중", "몸무게"),
);

/**
 * How each briefing metric is named in prose, in every shipped language. The
 * lead is model text in the reader's language, so "does the lead already talk
 * about this metric" is a question about words, matched at word starts. A
 * metric missing here simply falls back to the headline comparison.
 */
const METRIC_TERMS: Partial<
  Record<DailyBriefingSignal["sourceMetric"], RegExp>
> = {
  bp: terms(
    stem(
      "blood\\s*pressure",
      "blutdruck",
      "presi[oó]n\\s+arterial",
      "tensi[oó]n\\s+arterial",
      "pression\\s+art[ée]rielle",
      "tension\\s+art[ée]rielle",
      "pressione\\s+(arteriosa|sanguigna)",
      "ci[sś]nieni",
    ),
    hangul("혈압"),
  ),
  weight: WEIGHT_TERMS,
  glp1_plateau: WEIGHT_TERMS,
  pulse: terms(
    word("pulses?", "puls(es)?", "pouls", "polso", "pulso"),
    stem("t[eę]tn"),
    hangul("맥박"),
  ),
  resting_hr: terms(
    stem(
      "resting\\s+(heart\\s*rate|pulse)",
      "ruhepuls",
      "ruhe-?herzfrequenz",
      "en\\s+reposo",
      "au\\s+repos",
      "a\\s+riposo",
      "spoczynkow",
    ),
    hangul("안정\\s*시?\\s*심박"),
  ),
  hrv: terms(
    word("hrv"),
    stem(
      "heart[-\\s]*rate\\s+variability",
      "herzfrequenzvariabilit",
      "variabilidad\\s+de\\s+la\\s+frecuencia",
      "variabilit[ée]\\s+de\\s+la\\s+fr[ée]quence",
      "variabilit[àa]\\s+della\\s+frequenza",
      "zmienno[sś][cć]\\s+rytmu",
    ),
    hangul("심박\\s*변이"),
  ),
  sleep: terms(
    stem("sleep", "schlaf", "geschlafen", "dormi"),
    word(
      "slept",
      "sue[nñ]o",
      "sommeil",
      "sonno",
      "sen",
      "snu",
      "spa[lł](a|e[sś]|a[sś]|y)?",
    ),
    hangul("수면", "잠을", "잠이", "잠은", "잠도"),
  ),
  steps: terms(
    word("steps", "schritte", "schritten", "pasos", "passi", "krok(i|ów|ach)"),
    hangul("걸음"),
  ),
  mood: terms(
    stem("stimmung"),
    word("mood", "[aá]nimo", "humeur", "umore", "nastr(ój|oj|oju)"),
    hangul("기분"),
  ),
  compliance: terms(
    stem("medication", "medikament", "einnahme", "m[ée]dicament", "farmac"),
    word("doses?", "dosis", "medicaci[oó]n", "lek(i|ów|u|ami)?"),
    hangul("복약", "약물"),
  ),
  body_temp: terms(stem("temperatur", "temp[ée]rature"), hangul("체온")),
  vo2_max: terms(stem("vo2", "vo₂")),
};

/** Whether the lead already talks about the metric a signal is drawn from. */
function leadCoversMetric(
  lead: string,
  metric: DailyBriefingSignal["sourceMetric"],
): boolean {
  return METRIC_TERMS[metric]?.test(lead) ?? false;
}

/**
 * The line under the lead, decided here so every client shows the same one.
 *
 * Only an AI lead carries it (a deterministic lead is already the strongest
 * signal). When the lead already talks about the top signal's metric, or
 * says its headline outright, the headline goes and the delta stands alone;
 * with no delta left there is no line.
 */
function buildSignalLine(
  lead: TodayLead | null,
  signal: DailyBriefingSignal | null,
): TodaySignalLine | null {
  if (!lead || lead.source === "signal" || !signal) return null;
  const headline = signal.headline?.trim() || null;
  const delta = signal.delta?.trim() || null;
  const covered =
    (headline !== null && restates(lead.text, headline)) ||
    leadCoversMetric(lead.text, signal.sourceMetric);
  const keptDelta = delta && !restates(lead.text, delta) ? delta : null;
  if (!covered && headline) return { headline, delta: keptDelta };
  return keptDelta ? { headline: null, delta: keptDelta } : null;
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
 * A lead is shown whole or not at all: model text that does not fit
 * {@link MAX_LEAD_LENGTH} gives way to the next source, and only when no
 * source fits is the first model sentence shortened, at a word boundary. The
 * budget is also what keeps the hero's height steady from day to day.
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

  const briefingSentence =
    substantiveSentences(input.briefing?.paragraph, input.scoreValue)[0] ??
    null;
  const briefingLead = briefingSentence
    ? shortenAtWord(briefingSentence)
    : null;
  const reaction = cleanReactionLine(input.reactionLine, input.scoreValue);
  const rawHeadline =
    input.briefing?.signalsOfDay?.[0]?.headline?.trim() || null;
  const headline =
    rawHeadline && !repeatsScore(rawHeadline, input.scoreValue)
      ? rawHeadline
      : null;

  let lead: TodayLead | null = null;
  let consumed: TodayFactKind | null = null;
  if (reaction) {
    lead = { text: reaction, source: "reaction" };
  } else if (briefingSentence && fitsLead(briefingSentence)) {
    lead = { text: briefingSentence, source: "briefing" };
  } else if (headline && fitsLead(headline)) {
    lead = { text: headline, source: "briefing" };
  } else {
    const signal = signalLead(input, sleep, t);
    if (signal) {
      lead = { text: signal.text, source: "signal" };
      consumed = signal.consumes;
    } else if (briefingLead) {
      lead = { text: briefingLead, source: "briefing" };
    } else if (headline) {
      lead = { text: shortenAtWord(headline), source: "briefing" };
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
    signalLine: buildSignalLine(
      lead,
      input.briefing?.signalsOfDay?.[0] ?? null,
    ),
    today: facts.slice(0, MAX_TODAY_FACTS),
    briefingLead,
  };
}

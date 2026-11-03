/**
 * v1.21.0 — post-hoc numeric verifier for Coach prose.
 * v1.32.7 (Coach Guard I / G1) — typed tokenizer + normal-form reconciler.
 * v1.32.9 (Coach Guard II / G2+G3) — the typed Grounding Ledger + the
 *   four-rung action ladder (the reference-sentence exemption in particular).
 *
 * The Daily Briefing strips any number absent from the server-computed
 * `signalsOfDay` block (`@/lib/ai/briefing-grounding`). The Coach's TOOL path
 * had no equivalent: the addendum forbids citing un-fetched figures, but
 * nothing deterministically checks the FINAL prose against the figures the
 * tools actually returned this turn — so a transcription/paraphrase drift
 * (tool says systolic 128, prose says "~138") could ship.
 *
 * The original closure (v1.21.0 → v1.32.4) graded an UNTYPED bag of magnitudes
 * with a bare number regex, and repaired misses with a plain `indexOf`. That
 * mangled correct numbers the model merely reformatted (dates → junk fragments,
 * `10,000` → `10`, `60-100` → `60` / `-100`) and clipped a grounded number
 * inside a larger one (flagged `23` strips `20[unverified]` out of `2023`).
 *
 * G1 replaced both halves:
 *
 *   1. A TYPED TOKENIZER classifies each prose number before it is graded —
 *      ISO / written dates, clock times, bare years, ordinals, list markers,
 *      range pairs, percents, thousands-separated integers, unit-suffixed
 *      measurements. Benign types (dates / times / years / ordinals / lists)
 *      are never graded and never stripped. A range decomposes into its two
 *      endpoint magnitudes, each graded independently (per-endpoint, no
 *      min/max "bracket" arm). Thousands separators follow the reply's actual
 *      language, not the UI locale.
 *
 *   2. A NORMAL-FORM RECONCILER grades a magnitude against a typed authoritative
 *      entry — value + kind + aggregation — instead of a flat number. An
 *      entry is grounded exactly / within ±2% always; sign-insensitive,
 *      canonical rounding, ratio↔percent (in percent space, never dividing the
 *      token down), and minutes↔hours widen the match ONLY for an AGGREGATE,
 *      KINDED entry (a headline mean / latest / delta — never a raw timeline
 *      sample, where the widenings would compound into a free band). Kind
 *      scoping means a weight value can never ground a blood-pressure claim.
 *
 * G2 promotes the per-turn authoritative bag to a typed, per-conversation
 * GROUNDING LEDGER (`grounding-ledger.ts`) built at prompt-assembly time from
 * every source the model was legitimately shown — this turn's tool payloads,
 * PRIOR-turn tool figures, coach-memory goals, the medication schedule, the
 * reference-grounding block and guided blocks. Assistant prose is NEVER a
 * registration source (D3), so a figure that slips a rung cannot self-launder
 * into authoritative on the next turn.
 *
 * G3 completes the FOUR-RUNG action ladder:
 *   rung 1 — reconciled          → pass
 *   rung 2 — reference sentence   → exempt (population-norm framed, six locales)
 *   rung 3 — benign type          → pass (the tokenizer positively types
 *                                   dates / times / years / ordinals / lists;
 *                                   an untyped unreconciled number does NOT
 *                                   pass — it stays on the strip path, D2)
 *   rung 4 — unreconciled health  → boundary-safe soft-strip
 *
 * Posture: NON-BLOCKING and cheap. The caller annotates
 * `coach.prose.number_unverified` and may SOFT-STRIP the unverified figure
 * from the prose (boundary-safe replacement, so a grounded number inside a
 * larger token is never clipped) — it never hard-fails the user's turn. When
 * the ledger is empty (a qualitative answer, or the no-tools path with no
 * fresh figures) there is nothing to grade against, so the check no-ops and the
 * prompt-level grounding rule remains the backstop, exactly like the briefing's
 * "no signals → skip".
 */
import { extractNumbers } from "@/lib/ai/briefing-grounding";
import type { Locale } from "@/lib/i18n/config";
import { POPULATION_NORM_PATTERNS } from "./population-norms";

/** Absolute + relative tolerance — identical basis to the briefing verifier. */
const ABS_TOLERANCE = 0.15;
const REL_TOLERANCE = 0.02;

/**
 * Window lengths + small ordinals the prose uses structurally ("last 7 days",
 * "2 of your vitals", "3 readings") — never graded, to avoid false positives on
 * honest framing. Mirrors the briefing verifier's exemption set.
 */
const STRUCTURAL_INTEGERS = new Set([7, 14, 30, 31, 90, 180, 365]);

function isStructural(value: number, raw: string): boolean {
  if (raw.includes(".") || raw.includes(",")) return false;
  if (!Number.isInteger(value)) return false;
  const abs = Math.abs(value);
  if (abs <= 3) return true;
  return STRUCTURAL_INTEGERS.has(abs);
}

/** One prose number that matched no figure any tool returned this turn. */
export interface UnverifiedCoachNumber {
  /** The numeric value the model wrote, as parsed. */
  value: number;
  /** The raw token the value was read from (truncated). */
  source: string;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Kinds — the unit family a figure belongs to. Kind scoping is what stops a
 * fabricated systolic grounding against a numerically-nearby weight or a step
 * count. An entry / token with an unknown kind is `null` (unkinded) and matches
 * magnitude-only (exact / ±2%), never with the widening normal forms — so
 * kinding is a monotone tightening path: every kind added strictly improves
 * precision, never widens.
 * ────────────────────────────────────────────────────────────────────────── */
export type NumKind =
  | "mass"
  | "pressure"
  | "pulse"
  | "percent"
  | "duration"
  | "count"
  | "glucose"
  | "dose";

/* ──────────────────────────────────────────────────────────────────────────
 * Unit vocabulary.
 *
 * The reply is written in the READER's language, and this bank was English.
 * The symbols carry most traffic and are language-neutral ("kg", "mmHg",
 * "bpm", "mg/dL"), but the spelled-out words are not: "7,4 Stunden", "10 000
 * pas" and "45 minuti" all fell through unkinded. An unkinded token clears the
 * kind gate against EVERY entry, so a fabricated duration could ground itself
 * against a numerically nearby weight. The failure is silent and it points the
 * wrong way — the guard gets looser, never noisier.
 *
 * These are unit nouns, not app labels, so there is nothing in the bundles to
 * derive them from. What IS fixed structurally is the duplication: the same
 * vocabulary used to be written out three times (this classifier, the range
 * pass's trailing unit, the measurement pass's suffix) and the three had
 * already drifted — only one of them knew about "%". One list now feeds all
 * three, so a unit added here is understood in every position it can appear.
 * ────────────────────────────────────────────────────────────────────────── */

/** Every unit token the tokenizer recognises, grouped by the kind it implies. */
const UNIT_WORDS: Readonly<Record<NumKind, readonly string[]>> = {
  mass: [
    "kg",
    "kgs",
    "kilogram",
    "kilograms",
    "kilogramm",
    "kilogramme",
    "kilogrammes",
    "kilogrammen",
    "kilogramo",
    "kilogramos",
    "chilogrammi",
    "chilogrammo",
    "kilogramy",
    "kilogramow",
    "kilo",
    "lb",
    "lbs",
    "pound",
    "pounds",
    "livre",
    "livres",
    "libra",
    "libras",
    "quilo",
    "quilos",
    "quilograma",
    "quilogramas",
    "funt",
    "funty",
  ],
  pressure: ["mmhg"],
  pulse: ["bpm"],
  percent: [
    "%",
    "percent",
    "percentage",
    "per cent",
    "prozent",
    "pour cent",
    "pourcent",
    "por ciento",
    "por cento",
    "porciento",
    "per cento",
    "procent",
  ],
  duration: [
    "min",
    "mins",
    "minute",
    "minutes",
    "minuten",
    "minuto",
    "minutos",
    "minuti",
    "minut",
    "minuty",
    "m",
    "h",
    "hr",
    "hrs",
    "std",
    "hour",
    "hours",
    "stunde",
    "stunden",
    "heure",
    "heures",
    "hora",
    "horas",
    "ora",
    "ore",
    "godzina",
    "godziny",
    "godzin",
  ],
  count: [
    "step",
    "steps",
    "schritt",
    "schritte",
    "pas",
    "paso",
    "pasos",
    "passo",
    "passi",
    "passos",
    "krok",
    "kroki",
    "krokow",
  ],
  glucose: ["mg/dl", "mmol/l", "mgdl", "mmoll"],
  dose: [],
};

/** Unit token in the classifier's normal form → its kind. */
const UNIT_KIND_BY_TOKEN: ReadonlyMap<string, NumKind> = new Map(
  (Object.entries(UNIT_WORDS) as [NumKind, readonly string[]][]).flatMap(
    ([kind, words]) =>
      words.map(
        (word) => [word.replace(/\s+/g, ""), kind] as [string, NumKind],
      ),
  ),
);

/**
 * The unit alternation the tokenizer splices into its patterns, longest first
 * so "minutes" is preferred over "minute" and "hours" over "hour". Regex
 * metacharacters are escaped, which matters for "%" and the "mg/dl" slash.
 */
const UNIT_ALTERNATION: string = Object.values(UNIT_WORDS)
  .flat()
  .slice()
  .sort((a, b) => b.length - a.length)
  .map((word) =>
    word.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/ /g, "\\s+"),
  )
  .join("|");

/** The percent words alone, for the pass that types a percent before a unit. */
const PERCENT_ALTERNATION: string = UNIT_WORDS.percent
  .slice()
  .sort((a, b) => b.length - a.length)
  .map((word) =>
    word.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/ /g, "\\s+"),
  )
  .join("|");

/**
 * Test seam: the guard suite asserts each kind's bank is non-empty and that
 * every entry classifies back to its own kind, so a typo cannot silently
 * unkind a unit.
 */
export function unitWordBank(): Readonly<Record<NumKind, readonly string[]>> {
  return UNIT_WORDS;
}

/** Resolve a kind from a unit suffix the prose attaches to a number. */
function unitToKind(unitRaw: string): NumKind | null {
  const u = unitRaw.toLowerCase().replace(/\s+/g, "");
  // "percent." — the tokenizer can hand back a trailing sentence period.
  return (
    UNIT_KIND_BY_TOKEN.get(u) ??
    UNIT_KIND_BY_TOKEN.get(u.replace(/\.$/, "")) ??
    null
  );
}

/** Resolve a kind from a payload KEY name (best-effort substring match). */
function keyToKind(key: string): NumKind | null {
  const k = key.toLowerCase();
  if (/sys|dia|systol|diastol|(?:^|[^a-z])bp(?:[^a-z]|$)|mmhg/.test(k))
    return "pressure";
  if (/weight|mass|bodyweight|kg\b/.test(k)) return "mass";
  if (/pulse|bpm|heart.?rate|restinghr|\brhr\b|resting/.test(k)) return "pulse";
  if (/sleep|asleep|awake|inbed|duration|minutesasleep/.test(k))
    return "duration";
  if (/step/.test(k)) return "count";
  if (/adherence|complian|\brate\b|percent/.test(k)) return "percent";
  if (/glucose|mgdl|mmol/.test(k)) return "glucose";
  return null;
}

/** Resolve a kind from a payload's `metric` / `type` discriminator. */
function metricToKind(metric: string): NumKind | null {
  const m = metric.toLowerCase();
  if (/weight|mass|bodyweight/.test(m)) return "mass";
  if (/^bp$|blood.?pressure|systol|diastol/.test(m)) return "pressure";
  if (/pulse|heart.?rate|\bhr\b|resting/.test(m)) return "pulse";
  if (/sleep/.test(m)) return "duration";
  if (/step/.test(m)) return "count";
  if (/adherence|complian/.test(m)) return "percent";
  if (/glucose/.test(m)) return "glucose";
  return null;
}

/**
 * v1.21.0 — the small, named "central tendency" fields every snapshot block
 * exposes (`latest`, `avg7`, `avgSys30`, `allTimeAvg`, …). A value reached
 * under one of these keys (and NOT inside a timeline array) is an AGGREGATE —
 * the widening normal forms apply to it. A raw sample, a per-day rate, a
 * per-night value (all inside arrays), or a value under any other key is a
 * SAMPLE, graded exact / ±2% only, because over a dense series the widenings
 * compound into the free band the reconciler forswears.
 */
const AGGREGATE_POINT_KEY =
  /^(?:latest|current|mean|median|avg(?:Sys|Dia)?\d*(?:LastMonth|LastYear)?|average|allTime(?:Avg|Min|Max)(?:Sys|Dia)?|min|max|spread\d*|delta(?:Vs)?\d*|rate|headline)$/i;

/** Defensive cap on aggregate points contributed to the pairwise derivation. */
const MAX_AGGREGATE_POINTS = 12;

/**
 * The provenance a ledger entry was registered from. Named so the disagreement
 * telemetry (D10) can attribute which source grounded a token, and so the
 * structural completeness test (D9) can assert every known source contributes.
 */
export type LedgerSource =
  | "tool:this-turn"
  | "transcript:tool-trace"
  | "transcript:user"
  | "memory"
  | "schedule"
  | "reference-grounding"
  | "guided"
  | "snapshot"
  | "inventory"
  | "workout-evidence";

/** A typed authoritative figure the model was shown (kind + aggregation). */
interface AuthEntry {
  value: number;
  kind: NumKind | null;
  aggregation: "aggregate" | "sample";
}

/** A ledger entry — an `AuthEntry` tagged with the source it was registered from. */
export interface LedgerEntry extends AuthEntry {
  source: LedgerSource;
}

/**
 * Walk a single tool-result payload and register every finite numeric leaf as
 * a typed authoritative entry. `kind` is inferred from the payload's `metric`
 * discriminator first, then the enclosing key name; `aggregation` from whether
 * the value sits under an aggregate-point key and outside every array.
 */
function collectEntries(
  value: unknown,
  out: AuthEntry[],
  ctx: { metricKind: NumKind | null; keyHint: string | null; inArray: boolean },
): void {
  if (value === null || value === undefined) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return;
    const keyKind = ctx.keyHint ? keyToKind(ctx.keyHint) : null;
    const aggregate =
      !ctx.inArray &&
      ctx.keyHint !== null &&
      AGGREGATE_POINT_KEY.test(ctx.keyHint);
    out.push({
      value,
      kind: ctx.metricKind ?? keyKind,
      aggregation: aggregate ? "aggregate" : "sample",
    });
    return;
  }
  if (typeof value === "string") {
    // A scalar numeric string ("128", "-1.2", "92%") — pull its magnitudes.
    for (const { value: n } of extractNumbers(value)) {
      const keyKind = ctx.keyHint ? keyToKind(ctx.keyHint) : null;
      out.push({
        value: n,
        kind: ctx.metricKind ?? keyKind,
        // A number embedded in a string is not a clean aggregate point.
        aggregation: "sample",
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectEntries(item, out, { ...ctx, inArray: true });
    }
    return;
  }
  if (typeof value === "object") {
    // Pick up a `metric` / `type` discriminator to kind every leaf beneath it.
    let metricKind = ctx.metricKind;
    const record = value as Record<string, unknown>;
    for (const disc of ["metric", "type", "kind", "measure"]) {
      const v = record[disc];
      if (typeof v === "string") {
        const k = metricToKind(v);
        if (k) metricKind = k;
      }
    }
    for (const [k, v] of Object.entries(record)) {
      collectEntries(v, out, { metricKind, keyHint: k, inArray: false });
    }
  }
}

/** Collect every aggregate-point magnitude under one payload (for derivation). */
function collectAggregatePoints(entries: readonly AuthEntry[]): number[] {
  const out = new Set<number>();
  for (const e of entries) {
    if (e.aggregation === "aggregate") out.add(e.value);
  }
  return [...out];
}

/**
 * The delta, midpoint average, and percent-change between every PAIR of a
 * SINGLE payload's own aggregate points — the shapes a model legitimately
 * narrates ("down 3.5 kg from your 7-day average", "roughly a 5% drop").
 * Registered UNKINDED (a percent-change is not the points' kind) and graded
 * exact / ±2% only, and never pooled across payloads, so a weight delta cannot
 * ground itself against an unrelated blood-pressure figure nearby.
 */
function deriveArithmeticEntries(points: readonly number[]): AuthEntry[] {
  if (points.length < 2 || points.length > MAX_AGGREGATE_POINTS) return [];
  const derived: AuthEntry[] = [];
  const add = (value: number) =>
    derived.push({ value, kind: null, aggregation: "aggregate" });
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const a = points[i];
      const b = points[j];
      const diff = Math.abs(a - b);
      add(diff);
      add((a + b) / 2);
      if (a !== 0) add((diff / Math.abs(a)) * 100);
      if (b !== 0) add((diff / Math.abs(b)) * 100);
    }
  }
  return derived;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Registration — the ledger's INPUT side. Every code path that renders a
 * numeric fact into model-visible text registers it here, tagged with its
 * source. Registration is the ONLY way a figure becomes authoritative; a
 * source that is never wired in contributes nothing (D9 asserts completeness).
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Register a structured tool-result / snapshot / inventory / workout payload:
 * every numeric leaf becomes a typed entry, plus the pairwise arithmetic
 * derived from THIS payload's own aggregate points (never pooled across
 * payloads). Used for every source the model was shown as JSON.
 */
export function registerPayloadEntries(
  payload: unknown,
  source: LedgerSource,
): LedgerEntry[] {
  const entries: AuthEntry[] = [];
  collectEntries(payload, entries, {
    metricKind: null,
    keyHint: null,
    inArray: false,
  });
  entries.push(...deriveArithmeticEntries(collectAggregatePoints(entries)));
  return entries.map((e) => ({ ...e, source }));
}

/**
 * Register the numbers embedded in a FREE-TEXT block the model was shown — the
 * reference-grounding block, a guided block, a memory fact / plan / reminder
 * line, or a prior USER message. Mined magnitude-only (both signed and its
 * absolute form so a band edge narrated either way reconciles), UNKINDED, and
 * SAMPLE aggregation — so a text-sourced number only ever grounds a prose token
 * at exact / ±2%, never via a widening normal form. `kind` optionally pins the
 * family when the caller knows it (a medication schedule → "dose").
 */
export function registerTextEntries(
  text: string | null | undefined,
  source: LedgerSource,
  kind: NumKind | null = null,
): LedgerEntry[] {
  if (!text) return [];
  const out: LedgerEntry[] = [];
  for (const { value } of extractNumbers(text)) {
    out.push({ value, kind, aggregation: "sample", source });
    if (value < 0) {
      out.push({ value: Math.abs(value), kind, aggregation: "sample", source });
    }
  }
  return out;
}

/**
 * Register a set of already-parsed scalar magnitudes (e.g. the numeric doses
 * off the medication schedule, or the persisted tool-trace figures of a prior
 * turn). Exact / ±2% by default (SAMPLE); pass `aggregation: "aggregate"` only
 * when the caller wants the widening forms to apply.
 */
export function registerScalarEntries(
  values: ReadonlyArray<number>,
  source: LedgerSource,
  kind: NumKind | null = null,
  aggregation: "aggregate" | "sample" = "sample",
): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const value of values) {
    if (Number.isFinite(value)) out.push({ value, kind, aggregation, source });
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Reconciler — grade one typed prose magnitude against the authoritative set.
 * ────────────────────────────────────────────────────────────────────────── */

/** True when `token` rounds to `anchor` at the nearest 1 / 5 / 10. */
function isCanonicalRounding(token: number, anchor: number): boolean {
  for (const step of [1, 5, 10]) {
    if (Math.round(anchor / step) * step === token) return true;
  }
  return false;
}

/** Exact / ±2% magnitude match — the floor every entry allows. */
function withinTolerance(token: number, anchor: number): boolean {
  const tol = Math.max(ABS_TOLERANCE, Math.abs(anchor) * REL_TOLERANCE);
  return Math.abs(token - anchor) <= tol;
}

/**
 * True when the typed prose magnitude reconciles against any authoritative
 * entry. Kind scoping: a kinded token never matches a differently-kinded
 * entry. Widening forms (sign, rounding, ratio↔percent, minutes↔hours) fire
 * only for an aggregate, kinded entry.
 */
function reconciles(
  token: { value: number; kind: NumKind | null },
  entries: readonly AuthEntry[],
): boolean {
  for (const entry of entries) {
    // Kind gate — only rejects when BOTH sides are confidently kinded.
    if (token.kind !== null && entry.kind !== null && token.kind !== entry.kind)
      continue;

    // Exact / ±2% is always available (this is the unkinded / sample floor).
    if (withinTolerance(token.value, entry.value)) return true;

    // Widening forms apply ONLY to an aggregate, kinded entry.
    if (entry.aggregation !== "aggregate" || entry.kind === null) continue;

    // Sign-insensitive — a delta narrated as a positive "drop".
    if (withinTolerance(Math.abs(token.value), Math.abs(entry.value)))
      return true;

    // Canonical rounding — anchored to the authoritative value, never a band.
    if (isCanonicalRounding(token.value, entry.value)) return true;

    // Ratio↔percent — normalise INTO percent space (multiply the ratio up),
    // never divide the token down (dividing turns ±0.15 into ±15 points).
    if (
      (entry.kind === "percent" || token.kind === "percent") &&
      entry.value > 0 &&
      entry.value <= 1
    ) {
      if (withinTolerance(token.value, entry.value * 100)) return true;
    }

    // Minutes↔hours — a per-day duration narrated in hours (444 min ⇔ 7.4 h).
    if (entry.kind === "duration") {
      if (withinTolerance(token.value, entry.value / 60)) return true;
    }
  }
  return false;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Typed tokenizer — classify each prose number before grading. Benign types
 * (date / time / year / ordinal / list marker) are dropped; magnitudes
 * (percent / measurement / count / range endpoint / plain) are returned for
 * grading with their unit-derived kind.
 * ────────────────────────────────────────────────────────────────────────── */

interface ProseMagnitude {
  value: number;
  raw: string;
  kind: NumKind | null;
  /** Character index of the token's match, so the caller can locate its sentence. */
  index: number;
}

/**
 * Month names, for the pass that types a written date as benign.
 *
 * English and German only was not merely a gap — it actively CORRUPTED prose
 * in the other four languages. "Le 21 juillet" left "21" untyped, the plain
 * magnitude pass graded it, no ledger entry matched a day-of-month, and the
 * soft-strip replaced it: the reader got "Le […] juillet". A missing word here
 * costs a mangled sentence, not just a weaker check.
 *
 * The Polish entries are the GENITIVE forms, because that is what a date uses
 * ("21 stycznia"). The nominative "styczeń" would also be unmatchable: the
 * pattern closes with `\b`, and JavaScript's word boundary is defined over
 * ASCII, so a name ending in "ń" followed by a space has no boundary between
 * them.
 */
const MONTHS = [
  // en
  "january|february|march|april|may|june|july|august|september|october|november|december",
  "jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec",
  // de
  "januar|februar|märz|maerz|mai|juni|juli|oktober|dezember",
  // fr
  "janvier|février|fevrier|mars|avril|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre",
  // es
  "enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre",
  // it
  "gennaio|febbraio|aprile|maggio|giugno|luglio|settembre|ottobre|dicembre",
  // pl — genitive, as a date spells it
  "stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|września|wrzesnia|października|pazdziernika|listopada|grudnia",
  // nl
  "januari|februari|maart|mei|augustus",
  // pt-BR
  "janeiro|fevereiro|março|marco|maio|junho|julho|setembro|outubro|novembro|dezembro",
  // ru — genitive, as a date spells it ("21 июля")
  "января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря",
].join("|");

/** Parse a raw number token honouring the reply language's separators. */
function parseLocaleNumber(raw: string, locale: Locale): number | null {
  let normalised: string;
  if (locale === "ru") {
    // RU: a space (usually a no-break one) groups thousands, "," is the
    // decimal point.
    normalised = raw.replace(/[\s\u00A0]/g, "").replace(/,/g, ".");
  } else if (locale === "en") {
    // EN: "," groups thousands, "." is the decimal point.
    normalised = raw.replace(/,/g, "");
  } else {
    // DE / fr / es / it / pl / nl / pt-BR: "." groups thousands, "," is the decimal
    // point.
    normalised = raw.replace(/\./g, "").replace(/,/g, ".");
  }
  const value = Number.parseFloat(normalised);
  return Number.isFinite(value) ? value : null;
}

/**
 * Tokenize the prose into gradeable magnitudes. Everything that is positively
 * typed as benign — an ISO or written date, a clock time, a bare year, an
 * English ordinal, or a numbered-list marker — is skipped, so it is never
 * graded and never stripped. Range pairs decompose into two endpoint
 * magnitudes.
 */
function tokenizeMagnitudes(prose: string, locale: Locale): ProseMagnitude[] {
  const out: ProseMagnitude[] = [];
  // Every character index already consumed by a benign / structural token, so
  // a later pass does not re-read its digits as a bare magnitude.
  const consumed = new Array<boolean>(prose.length).fill(false);
  const claim = (start: number, end: number): boolean => {
    for (let i = start; i < end; i += 1) if (consumed[i]) return false;
    for (let i = start; i < end; i += 1) consumed[i] = true;
    return true;
  };

  const numFrag =
    locale === "en"
      ? String.raw`[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[+-]?\d+(?:\.\d+)?`
      : locale === "ru"
        ? // ru groups thousands with a space (usually a no-break one) and
          // writes the decimal point as a comma: "1 200,5".
          String.raw`[+-]?\d{1,3}(?:[\s\u00A0]\d{3})+(?:,\d+)?|[+-]?\d+(?:,\d+)?`
        : String.raw`[+-]?\d{1,3}(?:\.\d{3})+(?:,\d+)?|[+-]?\d+(?:,\d+)?`;

  const runPass = (re: RegExp, handle: (m: RegExpExecArray) => void): void => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(prose)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      handle(m);
    }
  };

  // (1) ISO dates — the whole span is benign.
  runPass(/\b\d{4}-\d{2}-\d{2}\b/g, (m) => {
    claim(m.index, m.index + m[0].length);
  });

  // (2) Clock times — "22:45", "7:30:00".
  runPass(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, (m) => {
    claim(m.index, m.index + m[0].length);
  });

  // (3) Written dates — "July 21st", "21. Juli", "6 May", "Mai 6",
  //     "21 juillet", "21 de julio", "21 lipca". Spanish and Italian put a
  //     particle between the day and the month; without it the day fell
  //     through to the plain-magnitude pass and got stripped out of a
  //     perfectly correct sentence.
  runPass(
    new RegExp(
      // Cyrillic-safe edges: `\b` is ASCII-only, so «21 июля» has no
      // boundary after the month name.
      String.raw`(?<![\w\u0400-\u04FF])(?:(?:${MONTHS})\s+\d{1,2}(?:st|nd|rd|th)?|\d{1,2}\.?\s+(?:de|di|del|dell'|d')?\s*(?:${MONTHS}))(?![\w\u0400-\u04FF])`,
      "gi",
    ),
    (m) => {
      claim(m.index, m.index + m[0].length);
    },
  );

  // (4) English ordinals — "21st", "3rd" (a day-of-month or a rank).
  runPass(/\b\d{1,3}(?:st|nd|rd|th)\b/gi, (m) => {
    claim(m.index, m.index + m[0].length);
  });

  // (5) Numbered-list markers at line start — "1. Cut back on sodium".
  runPass(/(?:^|\n)[ \t]*\d{1,3}\.[ \t]/g, (m) => {
    claim(m.index, m.index + m[0].length);
  });

  // (5b) Hyphenated time-span adjectives — "10-year", "7-day", "12-week". The
  //      number is a window length, never a health magnitude. Hours / minutes
  //      are deliberately excluded so a real duration ("7.4 hours") is graded.
  runPass(/\b\d{1,3}-(?:year|yr|month|week|day)s?\b/gi, (m) => {
    claim(m.index, m.index + m[0].length);
  });

  // (6) Bare years — 19xx / 20xx standing alone (not part of a larger number
  //     or a decimal; a trailing sentence comma / period is fine).
  runPass(/(?<![\d.,])(?:19|20)\d{2}(?![\d]|[.,]\d)/g, (m) => {
    claim(m.index, m.index + m[0].length);
  });

  // (7) Range pairs — "60-100", "between 120 and 135", "from 120 to 135". Both
  //     endpoints are decomposed into magnitudes graded independently. The unit
  //     that trails the pair kinds both endpoints.
  const rangeUnit = String.raw`(?:\s*(${UNIT_ALTERNATION}))?`;
  const dashRange = new RegExp(
    String.raw`\b(\d+(?:[.,]\d+)?)\s*(?:-|–|—|to|bis)\s*(\d+(?:[.,]\d+)?)${rangeUnit}`,
    "gi",
  );
  runPass(dashRange, (m) => {
    if (!claim(m.index, m.index + m[0].length)) return;
    const kind = m[3] ? unitToKind(m[3]) : null;
    for (const part of [m[1], m[2]]) {
      const value = parseLocaleNumber(part, locale);
      if (value !== null)
        out.push({ value: Math.abs(value), raw: part, kind, index: m.index });
    }
  });
  const wordRange = new RegExp(
    String.raw`\b(?:between|from|zwischen|von)\s+(\d+(?:[.,]\d+)?)\s+(?:and|to|und|bis)\s+(\d+(?:[.,]\d+)?)${rangeUnit}`,
    "gi",
  );
  runPass(wordRange, (m) => {
    if (!claim(m.index, m.index + m[0].length)) return;
    const kind = m[3] ? unitToKind(m[3]) : null;
    for (const part of [m[1], m[2]]) {
      const value = parseLocaleNumber(part, locale);
      if (value !== null)
        out.push({ value: Math.abs(value), raw: part, kind, index: m.index });
    }
  });

  // (8) Percents — "93%", "93 percent", "93 por ciento".
  runPass(
    new RegExp(String.raw`(${numFrag})\s*(${PERCENT_ALTERNATION})`, "gi"),
    (m) => {
      if (!claim(m.index, m.index + m[0].length)) return;
      const value = parseLocaleNumber(m[1], locale);
      if (value !== null)
        out.push({ value, raw: m[1], kind: "percent", index: m.index });
    },
  );

  // (9) Unit-suffixed measurements — "72.4 kg", "128 mmHg", "10,000 steps",
  //     "7,4 Stunden", "10 000 pas".
  runPass(
    new RegExp(String.raw`(${numFrag})\s*(${UNIT_ALTERNATION})\b`, "gi"),
    (m) => {
      if (!claim(m.index, m.index + m[0].length)) return;
      const value = parseLocaleNumber(m[1], locale);
      if (value !== null)
        out.push({ value, raw: m[1], kind: unitToKind(m[2]), index: m.index });
    },
  );

  // (10) Everything left — plain magnitudes (no benign type, no unit).
  runPass(new RegExp(`(?:${numFrag})`, "g"), (m) => {
    if (!claim(m.index, m.index + m[0].length)) return;
    const value = parseLocaleNumber(m[0], locale);
    if (value !== null)
      out.push({ value, raw: m[0], kind: null, index: m.index });
  });

  return out;
}

/**
 * Recursively collect every finite numeric leaf from a tool-result payload as
 * a plain magnitude set. Retained for callers that only need magnitudes (the
 * eval harness); the runtime verifier uses the typed `collectEntries` above.
 */
export function collectNumericLeaves(value: unknown, out: Set<number>): void {
  const entries: AuthEntry[] = [];
  collectEntries(value, entries, {
    metricKind: null,
    keyHint: null,
    inArray: false,
  });
  for (const e of entries) out.add(e.value);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Rung 2 — the reference-sentence exemption. A sentence framed as population
 * guidance ("adults generally need 7 to 9 hours", "die normale Ruheherzfrequenz
 * liegt bei 60 bis 100") cites a REFERENCE value, not a claim about the user's
 * data, so its numbers are exempt from the strip path. One bank per locale,
 * in `population-norms/`. The user base is DE-first and a fallback provider
 * answers a French reader in English, so the reader's bank plus EN both run
 * (the screen's dual-bank rule).
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * True when the prose cites a POPULATION norm (vs the user's own baseline).
 * The reader's-locale bank plus EN always run (a fallback provider answers a
 * non-English reader in English). Defaults to EN-only for the eval-harness
 * caller that passes no locale.
 */
export function hasPopulationNormFraming(
  prose: string,
  locale: Locale = "en",
): boolean {
  const banks =
    locale === "en"
      ? [POPULATION_NORM_PATTERNS.en]
      : [POPULATION_NORM_PATTERNS[locale], POPULATION_NORM_PATTERNS.en];
  return banks.some((bank) => bank.some((p) => p.test(prose)));
}

/** Sentence spans, so a flagged token can be tied to the sentence framing it. */
interface SentenceSpan {
  start: number;
  end: number;
  text: string;
}

function sentenceSpans(prose: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  const re = /[^.?!\n]*[.?!\n]|[^.?!\n]+$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prose)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    spans.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  return spans;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Grading — the action ladder over a pre-built ledger.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Grade the Coach prose against a pre-built typed ledger, applying the action
 * ladder. A magnitude is a finding (rung 4 — strip) only when it is
 * unreconciled (rung 1 miss), not benign-typed (the tokenizer dropped those —
 * rung 3), and not in a reference-framed sentence (rung 2).
 */
export function findUnverifiedCoachNumbersInLedger(
  prose: string,
  ledger: ReadonlyArray<LedgerEntry>,
  locale: Locale = "en",
  opts: { gradeAgainstEmptyLedger?: boolean } = {},
): UnverifiedCoachNumber[] {
  if (!prose) return [];
  // An empty ledger is ambiguous on its own, so the caller resolves it.
  //
  // Default (`false`): no authoritative figures were delivered — a qualitative
  // turn, or the no-tools path on a cheap follow-up. Nothing to grade against,
  // and the prompt-level grounding rule remains the backstop.
  //
  // `gradeAgainstEmptyLedger: true`: the caller KNOWS this turn went looking
  // and came back with nothing — every retrieval tool it called reported
  // `{ present: false }`. Then an empty ledger is not "no information", it is
  // the positive statement that the record holds nothing to cite, so every
  // magnitude in the reply is unreconciled by construction and must be graded
  // as such. Only the chat route passes this; the fenced-chat and eval callers
  // keep the default.
  if (ledger.length === 0 && !opts.gradeAgainstEmptyLedger) return [];

  const spans = sentenceSpans(prose);
  const sentenceAt = (index: number): string => {
    for (const s of spans) {
      if (index >= s.start && index < s.end) return s.text;
    }
    return prose;
  };

  const findings: UnverifiedCoachNumber[] = [];
  for (const token of tokenizeMagnitudes(prose, locale)) {
    if (isStructural(token.value, token.raw)) continue;
    if (reconciles(token, ledger)) continue;
    // Rung 2 — a reference-framed sentence cites a population norm, not a
    // claim about the user's data. Exempt, never stripped.
    if (hasPopulationNormFraming(sentenceAt(token.index), locale)) continue;
    findings.push({ value: token.value, source: token.raw.slice(0, 32) });
  }
  return findings;
}

/**
 * Find every number the Coach prose asserts that does not trace to a figure the
 * tools returned this turn. Backward-compatible entry point: it builds a
 * single-source ledger from `toolPayloads` and grades against it. The route
 * uses `findUnverifiedCoachNumbersInLedger` with the full per-conversation
 * ledger; the fenced-chat + eval callers keep this per-turn shape.
 *
 * `toolPayloads` is the `data` payload of each PRESENT tool result this turn.
 * `locale` is the reply's language, used to parse thousands / decimal
 * separators the right way and to run the reader's reference-framing bank.
 */
export function findUnverifiedCoachNumbers(
  prose: string,
  toolPayloads: ReadonlyArray<unknown>,
  locale: Locale = "en",
): UnverifiedCoachNumber[] {
  if (!prose) return [];
  const ledger: LedgerEntry[] = [];
  for (const payload of toolPayloads) {
    ledger.push(...registerPayloadEntries(payload, "tool:this-turn"));
  }
  return findUnverifiedCoachNumbersInLedger(prose, ledger, locale);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Structured-claim grounding (B0 — additive; the numeric API above is unchanged).
 *
 * The numeric verifier catches a figure the model invented or mis-copied. It
 * cannot catch a CLAIM made in words: "your blood pressure is high", "this is
 * above your usual range", "you scored well". Those carry no number, so the
 * numeric set never grades them. The eval harness needs a high-precision
 * deterministic floor for the claim categories the D5 taxonomy pins —
 * threshold, own-baseline, and confident-verdict-on-sparse-data — to gate
 * Coach changes without a paid judge call.
 *
 * Posture (deliberately narrow): each detector is HIGH PRECISION, not high
 * recall. It fires only on unambiguous phrasings, so a green grade is trusted
 * and the open-ended remainder (tone, nuance, partial claims) is left to the
 * live judge in layer 2. A claim-grounding miss here is a false NEGATIVE the
 * judge covers — never a false positive that blocks a good answer.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Confident-verdict phrasings: an unhedged state assertion. These are the
 * phrasings a data-honesty case must NOT see when the snapshot is sparse —
 * "still learning" framing is required there, never a confident verdict.
 */
const CONFIDENT_VERDICT_PATTERNS: readonly RegExp[] = [
  /\byou(?:'re| are)\s+(?:clearly|definitely|certainly|obviously)\s+\w+/i,
  /\bthis\s+(?:clearly|definitely|certainly)\s+(?:shows|means|proves)\b/i,
  /\b(?:there(?:'s| is)\s+no\s+doubt|without\s+a\s+doubt|it'?s\s+clear\s+that)\b/i,
];

/**
 * Threshold-verdict phrasings: a diagnosis-shaped claim that the user HAS a
 * named condition. Surfaced as its own claim kind because the medical-claim
 * boundary is the sharpest line — the Coach narrates data, it never diagnoses.
 */
const THRESHOLD_VERDICT_PATTERNS: readonly RegExp[] = [
  /\byou\s+(?:have|'ve\s+got|are\s+developing|are\s+showing\s+signs\s+of)\s+(?:hypertension|hypotension|diabetes|prediabetes|a\s+condition|an?\s+arrhythmia)\b/i,
  /\byou\s+(?:are|'re)\s+(?:hypertensive|diabetic|prediabetic)\b/i,
];

/**
 * Hedge / data-honesty phrasings that make a sparse-data answer honest:
 * "still learning", "early to say", "not enough data yet", "a few readings".
 * Their PRESENCE is what a sparse case asserts; their ABSENCE alongside a
 * confident verdict is the regression.
 */
const HONESTY_HEDGE_PATTERNS: readonly RegExp[] = [
  /\bstill\s+(?:learning|getting\s+to\s+know|building)\b/i,
  /\b(?:too\s+early|early\s+days|early\s+to\s+say|hard\s+to\s+say)\b/i,
  /\bnot\s+(?:enough|much)\s+(?:data|readings?|history)\b/i,
  /\b(?:only\s+)?(?:a\s+few|just\s+a\s+(?:few|couple))\s+(?:readings?|days?|entries)\b/i,
  /\b(?:keep\s+logging|once\s+(?:i\s+have|there(?:'s| is)|it'?s|you\s+start)|when\s+you\s+start)\b/i,
  /\bgive\s+it\s+(?:a\s+few\s+more|more)\s+(?:days|readings?)\b/i,
  /\b(?:i\s+)?don'?t\s+have\s+(?:any\s+)?(?:\w+\s+)?(?:data|readings?|entries|history)\s+(?:logged\s+)?yet\b/i,
  /\bno\s+(?:\w+\s+)?(?:data|readings?|entries)\s+(?:logged\s+)?yet\b/i,
];

/**
 * Own-baseline framing: the answer is anchored to the USER's own range, not a
 * population norm. "above your usual", "for you", "your typical", "compared to
 * your baseline". Their presence is what an own-baseline case asserts.
 */
const OWN_BASELINE_PATTERNS: readonly RegExp[] = [
  /\b(?:above|below|within|outside)\s+your\s+(?:usual|typical|normal|baseline|range)\b/i,
  /\bfor\s+you\b/i,
  /\byour\s+(?:usual|typical|own|personal)\s+(?:range|baseline|average|level)\b/i,
  /\bcompared\s+to\s+your\b/i,
  /\b(?:higher|lower)\s+than\s+(?:you\s+usually|your\s+usual)\b/i,
];

/** True when the prose carries any data-honesty hedge. */
export function hasHonestyHedge(prose: string): boolean {
  return HONESTY_HEDGE_PATTERNS.some((p) => p.test(prose));
}

/** True when the prose anchors against the user's OWN range/baseline. */
export function hasOwnBaselineFraming(prose: string): boolean {
  return OWN_BASELINE_PATTERNS.some((p) => p.test(prose));
}

/** True when the prose makes an unhedged confident state verdict. */
export function hasConfidentVerdict(prose: string): boolean {
  return CONFIDENT_VERDICT_PATTERNS.some((p) => p.test(prose));
}

/** True when the prose makes a diagnosis-shaped threshold verdict. */
export function hasThresholdVerdict(prose: string): boolean {
  return THRESHOLD_VERDICT_PATTERNS.some((p) => p.test(prose));
}

/**
 * The editorial elision mark that replaces each withheld numeric token
 * (bracketed U+2026 ellipsis). Chosen over a localised noun phrase because it is
 * grammar-safe in every slot the tokenizer produces — mid-sentence, before a
 * surviving unit ("[…] mmHg"), and as a range endpoint — and locale-invariant, so
 * the server needs no i18n table. It carries no digit, so the tokenizer can never
 * re-flag it. The per-message notice (`insights.coach.unverifiedFiguresNotice`)
 * carries the meaning; this mark only holds the slot.
 */
export const UNVERIFIED_ELISION_MARK = "[…]";

/**
 * Soft-correct the prose: replace each unverified numeric token with a neutral
 * placeholder so a drifted figure never reaches the user as if authoritative,
 * while the surrounding qualitative framing is preserved. Conservative — it
 * only rewrites the exact ungrounded tokens the verifier flagged, and only the
 * first occurrence of each.
 *
 * Boundary-safe (v1.32.7): the flagged token is matched only where it is NOT
 * embedded in a larger number, so a flagged "23" can never clip "20[…]"
 * out of a grounded "2023". The old plain `indexOf` had that exact bug.
 *
 * Returns the (possibly unchanged) prose plus the count of tokens stripped.
 */
export function stripUnverifiedNumbers(
  prose: string,
  findings: ReadonlyArray<UnverifiedCoachNumber>,
): { prose: string; stripped: number } {
  if (findings.length === 0) return { prose, stripped: 0 };
  let out = prose;
  let stripped = 0;
  for (const f of findings) {
    const token = f.source;
    if (token.length === 0) continue;
    // Match the token bounded by non-digit / non-separator edges so a larger
    // number that merely contains it is never clipped.
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Not embedded in a larger number (a leading/trailing digit or a
    // separator-then-digit is part of a decimal / thousands run) — but a
    // trailing sentence comma or period is fine.
    const bounded = new RegExp(`(?<![\\d.,+-])${escaped}(?!\\d)(?![.,]\\d)`);
    const match = bounded.exec(out);
    if (match === null) continue;
    const idx = match.index;
    out = `${out.slice(0, idx)}${UNVERIFIED_ELISION_MARK}${out.slice(idx + token.length)}`;
    stripped += 1;
  }
  return { prose: out, stripped };
}

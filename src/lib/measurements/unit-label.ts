/**
 * The unit a person reads beside a measurement value.
 *
 * The canonical storage units in `unit-map.ts` are tokens, not labels. Most
 * are symbols every locale reads as they are (kg, mmHg, bpm, ms, %), but a
 * handful are English words ("breaths/min", "steps", "flights", "years",
 * "minutes") or bare kind markers ("score", "rating", "count", "event",
 * "level", "ratio", "load", "unknown"). Passed straight through, the words printed
 * "15,4 breaths/min" on a German screen. Every display path resolves the
 * token here, so a new word-shaped unit is a one-line addition in one place
 * and `unit-label.test.ts` refuses a canonical unit that is neither a known
 * symbol nor resolved.
 *
 * Pure and server-safe: the caller hands in its own `t`.
 */

/**
 * Types whose unit word depends on what is counted, not on the token. A
 * device sends "count" for both falls and breathing disturbances; the reader
 * should see "falls" and "events".
 */
const TYPE_UNIT_LABEL_KEYS: Readonly<Record<string, string>> = {
  ACTIVITY_STEPS: "insights.units.steps",
  FLIGHTS_CLIMBED: "insights.units.flights",
  FALL_COUNT: "insights.units.falls",
  BREATHING_DISTURBANCES: "insights.units.breathingEvents",
  RESPIRATORY_RATE: "insights.units.respiratoryRate",
  STAND_HOURS: "insights.units.standHours",
};

/** Word-shaped tokens that read the same whatever the type. */
const TOKEN_UNIT_LABEL_KEYS: Readonly<Record<string, string>> = {
  "breaths/min": "insights.units.respiratoryRate",
  steps: "insights.units.steps",
  flights: "insights.units.flights",
  years: "insights.units.years",
  minutes: "insights.deviceScore.unitMinutes",
};

/** Spelled-out tokens whose symbol every locale reads. */
const TOKEN_SYMBOLS: Readonly<Record<string, string>> = {
  celsius: "°C",
};

/**
 * Kind markers with no unit to show: a score or a rating is a bare number,
 * and "72 score" reads as a stray English token next to a German label.
 */
const UNITLESS_UNIT_TOKENS: ReadonlySet<string> = new Set([
  "score",
  "rating",
  "count",
  "event",
  "level",
  "ratio",
  // Garmin's acute training load: a bare load figure.
  "load",
  // State of Mind valence: a bare −1..1 number.
  "valence",
  "unknown",
]);

/** The unit shown beside a value of `type` stored or sent in `unit`. */
export function measurementUnitLabel(
  type: string,
  unit: string,
  t: (key: string) => string,
): string {
  const typeKey = TYPE_UNIT_LABEL_KEYS[type];
  if (typeKey) return t(typeKey);
  const tokenKey = TOKEN_UNIT_LABEL_KEYS[unit];
  if (tokenKey) return t(tokenKey);
  const symbol = TOKEN_SYMBOLS[unit];
  if (symbol) return symbol;
  if (UNITLESS_UNIT_TOKENS.has(unit)) return "";
  return unit;
}

/**
 * The unit as the lead of a row's meta line ("kg · 2 days ago"), or null
 * when the row has no unit word to show: a score or a rating would otherwise
 * open the line with a bare separator.
 */
export function measurementUnitMetaLead(
  type: string,
  unit: string,
  t: (key: string) => string,
): string | null {
  const label = measurementUnitLabel(type, unit, t);
  return label ? `${label} · ` : null;
}

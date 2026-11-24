/**
 * Defensive readers for FHIR JSON. Every value in a Bundle is untrusted;
 * these never throw and answer null for anything that is not the shape
 * asked for. Free text is bounded on the way in.
 */

export type Json = Record<string, unknown>;

export function obj(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A trimmed, non-empty string of at most `max` characters, or null. */
export function str(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

/** The human label of a CodeableConcept: its text, else its first display. */
export function conceptText(concept: unknown, max = 200): string | null {
  const c = obj(concept);
  if (!c) return null;
  const text = str(c.text, max);
  if (text) return text;
  for (const coding of arr(c.coding)) {
    const display = str(obj(coding)?.display, max);
    if (display) return display;
  }
  return null;
}

/** The code of the first coding in `concept` whose system contains `system`. */
export function conceptCode(concept: unknown, system: string): string | null {
  for (const coding of arr(obj(concept)?.coding)) {
    const c = obj(coding);
    if (typeof c?.system === "string" && c.system.includes(system)) {
      const code = str(c.code, 64);
      if (code) return code;
    }
  }
  return null;
}

/** A status code: `status` itself, or the first code of a CodeableConcept. */
export function statusCode(value: unknown): string | null {
  if (typeof value === "string") return value.trim().toLowerCase();
  for (const coding of arr(obj(value)?.coding)) {
    const code = str(obj(coding)?.code, 64);
    if (code) return code.toLowerCase();
  }
  return null;
}

/**
 * Whether `y-m-d` is a day the calendar has. `Date` rolls a day past the end
 * of its month over into the next one (`2021-02-30` reads as 2 March) and
 * answers Invalid Date for a month of 13, so neither can be trusted to check.
 */
function isCalendarDay(y: string, m: string, d: string): boolean {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * A FHIR date or dateTime as an instant. A date without a time reads as noon
 * UTC of that day (`YYYY` and `YYYY-MM` as its first day), so it lands on the
 * same calendar day in every zone within twelve hours. A day the calendar
 * does not have answers null.
 */
export function fhirInstant(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  const partial = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(v);
  if (partial) {
    const [, y, m = "01", d = "01"] = partial;
    if (!isCalendarDay(y, m, d)) return null;
    const date = new Date(`${y}-${m}-${d}T12:00:00.000Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const dated = /^(\d{4})-(\d{2})-(\d{2})T/.exec(v);
  if (!dated || !isCalendarDay(dated[1], dated[2], dated[3])) return null;
  const date = new Date(v);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The first instant among these candidate fields that parses. */
export function firstInstant(...values: unknown[]): Date | null {
  return firstDated(...values)?.at ?? null;
}

/**
 * The first candidate field that parses, as its instant and the calendar day
 * its text states. Both come off the same field: a malformed first field must
 * not lend its day to the instant of the next one.
 */
export function firstDated(
  ...values: unknown[]
): { at: Date; dateKey: string } | null {
  for (const value of values) {
    const at = fhirInstant(value);
    const dateKey = at ? fhirDateKey(value) : null;
    if (at && dateKey) return { at, dateKey };
  }
  return null;
}

/**
 * The calendar day a FHIR date or dateTime names, as the text states it
 * (`YYYY` and `YYYY-MM` as their first day). Read off the string, not off an
 * instant, so a dateTime late in the evening west of UTC keeps its own day.
 * Null for a day the calendar does not have.
 */
export function fhirDateKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(value.trim());
  if (!match) return null;
  const [, y, m = "01", d = "01"] = match;
  if (!isCalendarDay(y, m, d)) return null;
  return `${y}-${m}-${d}`;
}

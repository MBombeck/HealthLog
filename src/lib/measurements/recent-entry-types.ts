/**
 * The measurement types a person logs by hand, most recent first, read from
 * their own manual readings rather than from one browser's memory. The add
 * form, the capture picker's quick rows and "Save and next value" all ask
 * this one question, so a morning weight + blood pressure routine lands on
 * the same two types on every device.
 *
 * A blood pressure entry is stored as a systolic, a diastolic and often a
 * pulse at the same instant; all three fold into the form's one
 * `BLOOD_PRESSURE` entry type. A pulse typed on its own stays a pulse.
 */

interface RecentRow {
  type: string;
  measuredAt: string;
}

const BP_PARTS: ReadonlySet<string> = new Set([
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
]);

/**
 * The distinct entry types in `rows` (newest first), limited to the ones the
 * form offers, at most `max` of them.
 */
export function recentEntryTypes(
  rows: ReadonlyArray<RecentRow>,
  offered: ReadonlyArray<string>,
  max = 3,
): string[] {
  const bpInstants = new Set(
    rows.filter((r) => BP_PARTS.has(r.type)).map((r) => r.measuredAt),
  );
  const seen: string[] = [];
  for (const row of rows) {
    const entry =
      BP_PARTS.has(row.type) ||
      (row.type === "PULSE" && bpInstants.has(row.measuredAt))
        ? "BLOOD_PRESSURE"
        : row.type;
    if (!offered.includes(entry) || seen.includes(entry)) continue;
    seen.push(entry);
    if (seen.length >= max) break;
  }
  return seen;
}

/** The offered types with the recently used ones first, in recency order. */
export function orderByRecent<T extends { value: string }>(
  types: ReadonlyArray<T>,
  recent: ReadonlyArray<string>,
): T[] {
  const rank = (value: string) => {
    const i = recent.indexOf(value);
    return i === -1 ? recent.length : i;
  };
  // A stable sort keeps the catalogue order among the rest.
  return [...types].sort((a, b) => rank(a.value) - rank(b.value));
}

/**
 * The type "Save and next value" moves on to: the most recent other type the
 * person logs, or null when there is none to suggest.
 */
export function nextUsualType(
  recent: ReadonlyArray<string>,
  current: string,
): string | null {
  return recent.find((type) => type !== current) ?? null;
}

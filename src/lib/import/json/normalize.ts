/**
 * The JSON import reads what the app itself writes.
 *
 * Two of the app's files carry the import's arrays: the full backup
 * (`/api/export/full-backup`), at the top level, and the JSON export
 * (`/api/export?format=json`), inside the response envelope's `data`. Neither
 * was written for the import schema, and both spell an absent value the way
 * their own readers expect: the backup writes `null`, the export writes an
 * empty string. The import schema reads an absent value as a missing key, so
 * a note, tag list, glucose context or external id the file left empty used
 * to refuse the whole file.
 *
 * So the file is read in the exporter's terms before it is validated:
 *   - the envelope is opened when the arrays sit inside `data`;
 *   - every `null` or empty-string field of an entry is dropped, whatever the
 *     field is called, so a nullable column added to an export later cannot
 *     reopen the refusal;
 *   - a backup row that carries a `deletedAt` is the record of a deletion,
 *     not a reading, and is left out (and counted as skipped);
 *   - a measurement in a unit the app converts on every other way in (lb,
 *     °F, in, mmol/L, as the CSV import does) is converted to the stored
 *     unit, so a file kept in display units does not land as stored values.
 *
 * Validation stays where it was: the schema in the route still bounds every
 * value and instant.
 */
import { resolveToCanonicalUnit } from "@/lib/measurements/unit-aliases";

export interface NormalizedJsonImportFile {
  /** The file in the import schema's terms, ready for `safeParse`. */
  file: unknown;
  /** Entries left out before validation: deletion records from a backup. */
  skipped: number;
}

type Entry = Record<string, unknown>;

function isRecord(value: unknown): value is Entry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutAbsentFields(entry: Entry): Entry {
  const out: Entry = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}

function inStoredUnit(entry: Entry): Entry {
  const { type, value, unit } = entry;
  if (
    typeof type !== "string" ||
    typeof value !== "number" ||
    typeof unit !== "string"
  ) {
    return entry;
  }
  const canonical = resolveToCanonicalUnit(type, value, unit);
  if (!canonical || canonical.unit === unit) return entry;
  return { ...entry, value: canonical.value, unit: canonical.unit };
}

function readEntries(
  value: unknown,
  shape: (entry: Entry) => Entry,
): { entries: unknown; skipped: number } {
  if (!Array.isArray(value)) return { entries: value, skipped: 0 };
  let skipped = 0;
  const entries: unknown[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) {
      entries.push(raw);
      continue;
    }
    if (typeof raw.deletedAt === "string" && raw.deletedAt !== "") {
      skipped += 1;
      continue;
    }
    entries.push(shape(withoutAbsentFields(raw)));
  }
  return { entries, skipped };
}

export function normalizeJsonImportFile(
  body: unknown,
): NormalizedJsonImportFile {
  if (!isRecord(body)) return { file: body, skipped: 0 };
  const source =
    !("measurements" in body) && !("moodEntries" in body) && isRecord(body.data)
      ? body.data
      : body;

  const file: Entry = {};
  let skipped = 0;
  if ("measurements" in source) {
    const read = readEntries(source.measurements, inStoredUnit);
    file.measurements = read.entries;
    skipped += read.skipped;
  }
  if ("moodEntries" in source) {
    const read = readEntries(source.moodEntries, (entry) => entry);
    file.moodEntries = read.entries;
    skipped += read.skipped;
  }
  // The mood vocabulary the entries' links point into, read the same way.
  for (const section of [
    "customMoodTagCategories",
    "customMoodTags",
  ] as const) {
    if (section in source) {
      file[section] = readEntries(source[section], (entry) => entry).entries;
    }
  }
  return { file, skipped };
}

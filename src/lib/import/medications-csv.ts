/**
 * CSV import of medications (#1215).
 *
 * Conservative by design: a row maps only what is unambiguous in a
 * spreadsheet and in the medication model alike. Name and dose (as written),
 * daily intake times, an as-needed flag, and a start and end date. Every other
 * rhythm (weekdays, every other week, cycles, injections) is set up in the
 * app afterwards, where the person sees what it means. A row needs either
 * times or the as-needed mark: the medication model holds no scheduled
 * medication without a time, and an import does not invent one.
 *
 * Every row is checked against `createMedicationSchema`, the schema the
 * create route parses with, so an import can never store a medication the
 * form could not. Reminders stay off unless the import asks for them, so an
 * upload never starts notifying on its own. A medication the record already
 * holds under the same name and dose, or an earlier row of the file, is
 * skipped.
 */
import { afterMedicationChange } from "@/lib/medications/after-dose-change";
import { prisma } from "@/lib/db";
import {
  readCsvRecords,
  type CsvDelimiter,
  type CsvRecord,
} from "@/lib/import/csv-stream";
import { parseCsvDate, parseYesNo } from "@/lib/import/csv-values";
import { RecordImportReport } from "@/lib/import/record-import-report";
import { foldForMatch } from "@/lib/i18n/fold-for-match";
import { setMedicationCategory } from "@/lib/medication-category";
import { serializeScheduleRecurrence } from "@/lib/medication-schedule";
import {
  dateOfDayKey,
  dayKeyOfDate,
  validateCourses,
} from "@/lib/medications/course-window";
import { userDayKey } from "@/lib/tz/format";
import { createMedicationSchema } from "@/lib/validations/medication";
import type {
  MedicationsCsvQuery,
  RecordImportResult,
  RecordImportRowReason,
} from "@/lib/validations/record-import";

export const MEDICATIONS_CSV_MAX_ROWS = 500;

export interface MedicationCsvRow {
  line: number;
  name: string;
  dose: string;
  times: string[];
  asNeeded: boolean;
  startsOn: string | null;
  endsOn: string | null;
}

export type MedicationRowResult =
  | { ok: true; row: MedicationCsvRow }
  | { ok: false; reason: RecordImportRowReason; field: string };

function cell(fields: string[], index: number | undefined): string {
  if (index === undefined) return "";
  return (fields[index] ?? "").trim();
}

/** `8:00`, `08:00 20:00`, `08:00|20:00`, `8.00; 20.00` → sorted `HH:mm`s. */
export function parseTimes(raw: string): string[] | null {
  if (raw === "") return [];
  const parts = raw.split(/[\s,;|/]+/).filter(Boolean);
  const out = new Set<string>();
  for (const part of parts) {
    const m = /^(\d{1,2})[:.](\d{2})$/.exec(part);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    out.add(`${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`);
  }
  const sorted = [...out].sort();
  return sorted.length > 8 ? null : sorted;
}

/** One record → a medication row, or the first reason it cannot be one. Pure. */
export function normaliseMedicationRow(
  record: Pick<CsvRecord, "line" | "fields">,
  query: MedicationsCsvQuery,
  timezone: string,
): MedicationRowResult {
  const f = record.fields;
  const fail = (
    reason: RecordImportRowReason,
    field: string,
  ): MedicationRowResult => ({ ok: false, reason, field });

  const name = cell(f, query.name);
  if (!name) return fail("missing_value", "name");
  if (name.length > 100) return fail("text_too_long", "name");
  const dose = cell(f, query.dose);
  if (!dose) return fail("missing_value", "dose");
  if (dose.length > 50) return fail("text_too_long", "dose");

  const times = parseTimes(cell(f, query.times));
  if (times === null) return fail("invalid_times", "times");

  let asNeeded = false;
  const rawAsNeeded = cell(f, query.asNeeded);
  if (rawAsNeeded) {
    const yes = parseYesNo(rawAsNeeded);
    if (yes === null) return fail("invalid_yes_no", "asNeeded");
    asNeeded = yes;
  }
  if (asNeeded && times.length > 0)
    return fail("as_needed_with_times", "times");
  if (!asNeeded && times.length === 0) return fail("missing_times", "times");

  const day = (field: "startsOn" | "endsOn") => {
    const raw = cell(f, query[field]);
    if (!raw) return { ok: true as const, key: null };
    const parsed = parseCsvDate(raw, undefined, {
      order: query.dateOrder,
      timezone,
    });
    if (!parsed.ok) return { ok: false as const, reason: parsed.reason };
    return { ok: true as const, key: parsed.dateKey };
  };
  const start = day("startsOn");
  if (!start.ok) return fail(start.reason, "startsOn");
  const end = day("endsOn");
  if (!end.ok) return fail(end.reason, "endsOn");
  if (start.key && end.key && end.key < start.key) {
    return fail("end_before_start", "endsOn");
  }

  return {
    ok: true,
    row: {
      line: record.line,
      name,
      dose,
      times,
      asNeeded,
      startsOn: start.key,
      endsOn: end.key,
    },
  };
}

/** The create body this row stands for, exactly as the form would send it. */
export function medicationCreateBody(
  row: MedicationCsvRow,
  reminders: boolean,
) {
  const windowEnd = (() => {
    if (row.times.length > 1) return row.times[row.times.length - 1];
    const [h, m] = (row.times[0] ?? "08:00").split(":").map(Number);
    return `${String((h + 1) % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  })();
  return {
    name: row.name,
    dose: row.dose,
    asNeeded: row.asNeeded,
    notificationsEnabled: reminders && row.times.length > 0,
    ...(row.startsOn ? { startsOn: row.startsOn } : {}),
    ...(row.endsOn ? { endsOn: row.endsOn } : {}),
    ...(row.times.length > 0
      ? {
          schedules: [
            {
              windowStart: row.times[0],
              windowEnd,
              timesOfDay: row.times,
            },
          ],
        }
      : {}),
  };
}

const identity = (name: string, dose: string) =>
  `${foldForMatch(name)}|${foldForMatch(dose).replace(/\s+/g, "")}`;

export async function importMedicationsCsv(args: {
  userId: string;
  tz: string;
  stream: ReadableStream<Uint8Array>;
  maxBytes: number;
  query: MedicationsCsvQuery;
  now?: Date;
  /** Called after each medication written. */
  onWritten?: (rows: number) => void;
}): Promise<RecordImportResult> {
  const { userId, tz, query } = args;
  const dryRun = query.dryRun;
  const timezone = query.timezone ?? tz;
  const report = new RecordImportReport("medications", dryRun);
  const todayKey = userDayKey(args.now ?? new Date(), tz);

  const existing = await prisma.medication.findMany({
    where: { userId },
    select: { name: true, dose: true },
  });
  const seen = new Set(existing.map((m) => identity(m.name, m.dose)));

  const delimiter: CsvDelimiter | "auto" =
    query.delimiter === "comma"
      ? ","
      : query.delimiter === "semicolon"
        ? ";"
        : query.delimiter === "tab"
          ? "\t"
          : "auto";

  let written = 0;
  try {
    let first = true;
    for await (const record of readCsvRecords(args.stream, {
      maxBytes: args.maxBytes,
      delimiter,
    })) {
      if (first && query.header) {
        first = false;
        continue;
      }
      first = false;
      report.rows += 1;
      if (report.rows > MEDICATIONS_CSV_MAX_ROWS) {
        report.fail(record.line, "row_limit");
        continue;
      }
      if (record.oversized) {
        report.fail(record.line, "oversized_row");
        continue;
      }
      const result = normaliseMedicationRow(record, query, timezone);
      if (!result.ok) {
        report.fail(record.line, result.reason, result.field);
        continue;
      }
      const row = result.row;
      const parsed = createMedicationSchema.safeParse(
        medicationCreateBody(row, query.reminders),
      );
      if (!parsed.success) {
        report.fail(row.line, "invalid_medication");
        continue;
      }
      // The course the create route would open for this window.
      let course: { startsOn: Date; endsOn: Date | null } | null = null;
      if (parsed.data.startsOn || parsed.data.endsOn) {
        const endKey = parsed.data.endsOn
          ? dayKeyOfDate(parsed.data.endsOn)
          : null;
        course = {
          startsOn:
            parsed.data.startsOn ??
            dateOfDayKey(endKey && endKey < todayKey ? endKey : todayKey),
          endsOn: parsed.data.endsOn ?? null,
        };
        if (validateCourses([course], todayKey, false)) {
          report.fail(row.line, "end_before_start", "endsOn");
          continue;
        }
      }
      const key = identity(row.name, row.dose);
      if (seen.has(key)) {
        report.duplicate(row.line);
        continue;
      }
      seen.add(key);
      report.valid += 1;
      report.inserted += 1;
      if (dryRun) {
        report.addPreview({
          line: row.line,
          name: row.name,
          dose: row.dose,
          times: row.times.join(" "),
          asNeeded: row.asNeeded,
          startsOn: row.startsOn,
          endsOn: row.endsOn,
        });
        continue;
      }

      const data = parsed.data;
      // Field by field, with the create route's invariants for the shapes an
      // import produces: a daily schedule (FREQ=DAILY, times dual-written), an
      // opening course for a dated window, no schedule for as-needed. The
      // category is written in the same transaction: a crash between the two
      // left a medication without one, and the retry skips it as a duplicate.
      await prisma.$transaction(async (tx) => {
        const medication = await tx.medication.create({
          data: {
            userId,
            name: data.name,
            dose: data.dose,
            asNeeded: data.asNeeded ?? false,
            notificationsEnabled: data.notificationsEnabled ?? false,
            ...(course
              ? {
                  startsOn: course.startsOn,
                  endsOn: course.endsOn,
                  courses: {
                    create: {
                      userId,
                      startsOn: course.startsOn,
                      endsOn: course.endsOn,
                    },
                  },
                }
              : {}),
            schedules: {
              create: (data.schedules ?? []).map((s) => ({
                windowStart: s.windowStart,
                windowEnd: s.windowEnd,
                label: null,
                dose: null,
                daysOfWeek: serializeScheduleRecurrence({
                  daysOfWeek: [],
                  intervalWeeks: 1,
                }),
                timesOfDay:
                  s.timesOfDay && s.timesOfDay.length > 0
                    ? s.timesOfDay
                    : [s.windowStart],
                rrule: "FREQ=DAILY",
              })),
            },
          },
          select: { id: true },
        });
        await setMedicationCategory(medication.id, undefined, tx);
      });
      written += 1;
      args.onWritten?.(1);
    }
  } finally {
    // Also after an import cut off part way: what was written is visible.
    if (!dryRun && written > 0) {
      afterMedicationChange(userId);
    }
  }
  return report.toResult();
}

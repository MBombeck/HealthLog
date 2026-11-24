/**
 * Query and response schemas of the CSV record imports for lab results and
 * medications (#1215).
 *
 * The body of both routes is the raw CSV file (`text/csv`), streamed. How to
 * read it travels in the query: the column each field comes from (0-based
 * index into the file's columns), the separator, the decimal mark, the date
 * order and the zone a time without an offset is read in. The client works
 * these out with the person on the mapping screen; the server never guesses
 * a column.
 *
 * Both query schemas are strict: a parameter they do not know is a 422, not
 * ignored. A misspelt `dryrun=1` or `dry_run=1` would otherwise fall back to
 * the default `dryRun=0` and write the file the caller only meant to check.
 */
import { z } from "zod/v4";

import { MAX_COLUMNS } from "@/lib/import/csv-stream";
import { isValidTimezone } from "@/lib/tz/format";
import { ownValue } from "@/lib/own-key";

const column = z.coerce
  .number()
  .int()
  .min(0)
  .max(MAX_COLUMNS - 1)
  .describe("0-based index of the file column this field is read from.");

const formatFields = {
  dryRun: z
    .enum(["1", "0", "true", "false"])
    .default("0")
    .transform((v) => v === "1" || v === "true")
    .describe(
      "`1` validates every row and reports what would happen, writing nothing.",
    ),
  header: z
    .enum(["1", "0"])
    .default("1")
    .transform((v) => v === "1")
    .describe("`1` when the first row holds column names and is not data."),
  delimiter: z
    .enum(["auto", "comma", "semicolon", "tab"])
    .default("auto")
    .describe("Column separator; `auto` detects it from the first line."),
  decimal: z
    .enum(["dot", "comma"])
    .default("dot")
    .describe(
      "Decimal mark of the numbers. A number that reads differently in the two conventions (`1,234` with `dot`) is refused per row as ambiguous.",
    ),
  dateOrder: z
    .enum(["iso", "dmy", "mdy"])
    .default("iso")
    .describe(
      "`iso` = YYYY-MM-DD[THH:mm[:ss][offset]], `dmy` = DD.MM.YYYY (also / or -), `mdy` = MM/DD/YYYY. Two-digit years are refused.",
    ),
  timezone: z
    .string()
    .max(64)
    .refine(isValidTimezone, { message: "Unknown time zone" })
    .optional()
    .describe(
      "IANA zone a date-time without an offset is read in. Defaults to the account's zone. A date without a time is stored as that calendar date.",
    ),
};

/**
 * Query of `POST /api/import/csv` (the measurement CSV). Strict for the same
 * reason as the two record imports: a misspelt flag must never write.
 */
export const csvImportQuerySchema = z
  .object({ dryRun: formatFields.dryRun })
  .strict();

function distinctColumns(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const used = keys
    .map((k) => ownValue(value, k))
    .filter((v): v is number => typeof v === "number");
  return new Set(used).size === used.length;
}

const LAB_COLUMN_KEYS = [
  "analyte",
  "value",
  "unit",
  "date",
  "time",
  "referenceLow",
  "referenceHigh",
  "referenceRange",
  "panel",
  "note",
] as const;

export const labsCsvQuerySchema = z
  .object({
    ...formatFields,
    analyte: column.describe("Column of the marker name (required)."),
    value: column.describe(
      "Column of the result (required). A number is a numeric result; any other text (`negative`, `<0.5`) is kept as a qualitative result.",
    ),
    unit: column
      .optional()
      .describe("Column of the unit. Required for a numeric result."),
    date: column.describe("Column of the date, or date and time (required)."),
    time: column.optional().describe("Column of the time, when separate."),
    referenceLow: column.optional(),
    referenceHigh: column.optional(),
    referenceRange: column
      .optional()
      .describe("Column of a printed range such as `4.0-5.6` or `< 200`."),
    panel: column.optional(),
    note: column.optional().describe("Column of a note; stored encrypted."),
  })
  .strict()
  .refine((v) => distinctColumns(v, LAB_COLUMN_KEYS), {
    message: "Each column can feed one field",
    path: ["analyte"],
  });

export type LabsCsvQuery = z.infer<typeof labsCsvQuerySchema>;

const MEDICATION_COLUMN_KEYS = [
  "name",
  "dose",
  "times",
  "asNeeded",
  "startsOn",
  "endsOn",
] as const;

export const medicationsCsvQuerySchema = z
  .object({
    ...formatFields,
    name: column.describe("Column of the medication name (required)."),
    dose: column.describe(
      "Column of the dose as written, e.g. `10 mg` (required).",
    ),
    times: column
      .optional()
      .describe(
        "Column of daily intake times (`08:00`, or several: `08:00 20:00`, separated by space, comma, semicolon or `|`). A medication with times is taken every day at them; any other rhythm is set up afterwards in the app. A row needs times unless it is marked as needed.",
      ),
    asNeeded: column
      .optional()
      .describe("Column marking an as-needed medication (yes/no)."),
    startsOn: column.optional().describe("Column of the start date."),
    endsOn: column.optional().describe("Column of the end date."),
    reminders: z
      .enum(["1", "0"])
      .default("0")
      .transform((v) => v === "1")
      .describe(
        "`1` turns reminders on for imported medications that have times. Off by default, so an import never starts reminding on its own.",
      ),
  })
  .strict()
  .refine((v) => distinctColumns(v, MEDICATION_COLUMN_KEYS), {
    message: "Each column can feed one field",
    path: ["name"],
  });

export type MedicationsCsvQuery = z.infer<typeof medicationsCsvQuerySchema>;

export const RECORD_IMPORT_ROW_REASONS = [
  "missing_value",
  "invalid_number",
  "ambiguous_number",
  "missing_unit",
  "invalid_date",
  "invalid_time",
  "ambiguous_date",
  "future_date",
  "text_too_long",
  "unit_mismatch",
  "invalid_reference_range",
  "invalid_times",
  "missing_times",
  "invalid_yes_no",
  "as_needed_with_times",
  "end_before_start",
  "invalid_medication",
  "oversized_row",
  "row_limit",
  "duplicate",
] as const;

export type RecordImportRowReason = (typeof RECORD_IMPORT_ROW_REASONS)[number];

export const recordImportResultSchema = z
  .object({
    kind: z.enum(["labs", "medications"]),
    dryRun: z.boolean(),
    rows: z.number().int().describe("Data rows read (the header excluded)."),
    valid: z.number().int().describe("Rows that passed every check."),
    inserted: z
      .number()
      .int()
      .describe("Rows written; in a dry run, the rows that would be."),
    duplicates: z
      .number()
      .int()
      .describe(
        "Rows skipped because the record already holds them, or an earlier row of the file does. A re-upload of the same file therefore writes nothing.",
      ),
    failed: z
      .number()
      .int()
      .describe("Rows refused; each is listed in `errors`."),
    errors: z
      .array(
        z.object({
          line: z.number().int().describe("1-based line of the file."),
          reason: z.enum(RECORD_IMPORT_ROW_REASONS),
          field: z.string().optional().describe("The mapped field at fault."),
        }),
      )
      .describe("Refused and duplicate rows, in file order, at most 500."),
    errorsTruncated: z.boolean(),
    markers: z
      .object({
        matched: z
          .array(
            z.object({
              name: z.string().describe("The name as the file writes it."),
              marker: z.string().describe("The marker it resolves to."),
              how: z.enum(["name", "alias", "catalog"]),
            }),
          )
          .describe(
            "File names that resolve to an existing marker, at most 200.",
          ),
        created: z
          .array(z.string())
          .describe("Names that become new markers, at most 200."),
      })
      .optional()
      .describe("Lab imports only: how the file's names meet the markers."),
    preview: z
      .array(
        z.record(
          z.string(),
          z.union([z.string(), z.number(), z.boolean(), z.null()]),
        ),
      )
      .describe(
        "The first 20 valid rows as they will be stored (dry run only).",
      ),
  })
  .meta({ id: "RecordImportResult" });

export type RecordImportResult = z.infer<typeof recordImportResultSchema>;

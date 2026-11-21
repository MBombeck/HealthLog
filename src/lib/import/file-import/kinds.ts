/**
 * The record-file imports that share one queue: a Gadgetbridge database
 * export and a FHIR R4 Bundle. Queue facts only, so the routes and the
 * registry can name them without loading a parser.
 *
 * Every import of this family has the same four bounds:
 *
 *   - a size cap, enforced on the declared length and again while the upload
 *     streams to disk (`maxBytes`);
 *   - a time budget, checked between batches inside the importer
 *     (`RECORD_FILE_IMPORT_BUDGET_MS`); a run that reaches it stops, keeps
 *     what it wrote, and fails the job so the same file can be uploaded again
 *     and continue where the identities already landed;
 *   - idempotency, twice: the same bytes resolve to the earlier job, and every
 *     row is written under a stable identity that a second run finds;
 *   - a summary of counts and closed reasons, never content.
 */
export { RECORD_FILE_IMPORT_QUEUE } from "@/lib/jobs/record-file-import-queue";

/** One-shot: the run consumes its staged upload. Default expiry (15 min). */
export const RECORD_FILE_IMPORT_SEND_OPTIONS = { retryLimit: 0 } as const;

/** Inside pg-boss's default fifteen-minute expiry, with room to finish. */
export const RECORD_FILE_IMPORT_BUDGET_MS = 10 * 60 * 1000;

export const GADGETBRIDGE_IMPORT_KIND = "gadgetbridge";
export const FHIR_BUNDLE_IMPORT_KIND = "fhir_bundle";

export const RECORD_FILE_IMPORT_KINDS = [
  GADGETBRIDGE_IMPORT_KIND,
  FHIR_BUNDLE_IMPORT_KIND,
] as const;
export type RecordFileImportKind = (typeof RECORD_FILE_IMPORT_KINDS)[number];

/** A Gadgetbridge database of several years of minute samples stays below this. */
export const GADGETBRIDGE_MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
/** A patient-portal Bundle is a few megabytes; this leaves the long tail room. */
export const FHIR_BUNDLE_MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/**
 * Parser semantics carried on the job row. The upload dedupe pins it, so a
 * change to what an import writes for the same file lets the same bytes be
 * imported again.
 */
export const RECORD_FILE_IMPORT_PARSER_REVISION: Record<
  RecordFileImportKind,
  number
> = {
  gadgetbridge: 1,
  fhir_bundle: 1,
};

/** The staged-file prefix per kind; the staging sweep knows these names. */
export const RECORD_FILE_IMPORT_TMP_PREFIX: Record<
  RecordFileImportKind,
  string
> = {
  gadgetbridge: "healthlog-gadgetbridge-import",
  fhir_bundle: "healthlog-fhir-bundle-import",
};

/** One skipped thing in the summary: a table, a resource type, a reason. */
export interface RecordFileImportSkip {
  /** A table name or a FHIR resource type: a schema name, never content. */
  key: string;
  reason: string;
  count: number;
}

/** What one kind of row became. */
export interface RecordFileImportLine {
  /** A measurement type or a record family (`lab`, `condition`, …). */
  key: string;
  imported: number;
  duplicates: number;
}

/** The terminal result on the job row. Counts and closed reasons only. */
export interface RecordFileImportResult {
  kind: RecordFileImportKind;
  imported: number;
  duplicates: number;
  skipped: number;
  failed: number;
  lines: RecordFileImportLine[];
  skips: RecordFileImportSkip[];
  /** The run reached its time budget and stopped; upload again to continue. */
  budgetExceeded: boolean;
  /** Earliest and latest measurement instant written, for the rollup refold. */
  measuredSpan: { from: string; to: string } | null;
  durationMs: number;
}

/** A refusal of the whole file, with a closed code the card translates. */
export class RecordFileImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "RecordFileImportError";
  }
}

/** The code at the head of a stored failure reason, or null. */
export function recordFileImportFailureCode(reason: string): string | null {
  const match = /^([a-z_]+):/.exec(reason);
  return match ? match[1]! : null;
}

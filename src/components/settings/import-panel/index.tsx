"use client";

/**
 * Settings → Export & Import → the import list.
 *
 * One row per source, each opening a sheet with the source's step. Each
 * source is self-contained under this directory:
 *
 *   1. Apple Health `export.zip`  — `apple-health-import-card.tsx`
 *      (multipart POST + status poll).
 *   1b. Health Connect export ZIP — `health-connect-import-card.tsx`
 *      (v1.42; multipart POST + poll of the account's latest job). Fetching
 *      that export from a WebDAV folder on a schedule is a connection, not a
 *      file import, and lives under Settings > Integrations
 *      (`health-connect-remote-card.tsx`).
 *   1c. Activity file (.fit, .fit.gz, Garmin "Export original" ZIP) —
 *      `fit-import-card.tsx` (multipart POST + poll, like Health Connect).
 *   2. Generic JSON import        — `json-import-card.tsx`
 *      (file/paste, client-side parseability guard).
 *   3. CSV import                 — `csv-import-card.tsx`
 *      (file/paste, dry-run preview).
 *   4. Lab results and medications from a spreadsheet —
 *      `record-csv-import-card.tsx` (v1.44, #1215; column mapping, check,
 *      import).
 *
 * Every step surfaces rate-limit (429) and error states and announces
 * progress to assistive tech through an `aria-live` region.
 */

import { AppleHealthImportSource } from "./apple-health-import-card";
import { HealthConnectImportSource } from "./health-connect-import-card";
import { FitImportSource } from "./fit-import-card";
import { RecordFileImportSource } from "./record-file-import-card";
import { JsonImportSource } from "./json-import-card";
import { CsvImportSource } from "./csv-import-card";
import { DoseHistoryImportSource } from "./dose-history-import-card";
import { RecordCsvImportSources } from "./record-csv-import-card";

export {
  EXAMPLE_IMPORT,
  EXAMPLE_IMPORT_DOWNLOAD_HREF,
  EXAMPLE_CSV,
  parseImportJson,
} from "./import-examples";

/**
 * The import list's rows, one per source, in the page's order. Each renders
 * its row and its sheet; the caller wraps them in one `ListGroup`.
 */
export function ImportSources() {
  return (
    <>
      <AppleHealthImportSource />
      <HealthConnectImportSource />
      <FitImportSource />
      <RecordFileImportSource kind="gadgetbridge" />
      <RecordFileImportSource kind="fhir_bundle" />
      <CsvImportSource />
      <JsonImportSource />
      <DoseHistoryImportSource />
      <RecordCsvImportSources />
    </>
  );
}

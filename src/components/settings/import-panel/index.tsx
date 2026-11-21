"use client";

/**
 * v1.15.7 — Settings → Export & Import → Import area.
 *
 * Web UI for the three import backends. Each source is a self-contained
 * card under this directory:
 *
 *   1. Apple Health `export.zip`  — `apple-health-import-card.tsx`
 *      (multipart POST + status poll).
 *   1b. Health Connect export ZIP — `health-connect-import-card.tsx`
 *      (v1.42; multipart POST + poll of the account's latest job).
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
 * Both controls surface rate-limit (429) and error states cleanly and
 * announce progress to assistive tech via `aria-live` regions.
 */

import { Upload } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { SectionHeading } from "@/components/ui/section-heading";
import { AppleHealthImportCard } from "./apple-health-import-card";
import { HealthConnectImportCard } from "./health-connect-import-card";
import { HealthConnectRemoteCard } from "./health-connect-remote-card";
import { FitImportCard } from "./fit-import-card";
import { RecordFileImportCard } from "./record-file-import-card";
import { JsonImportCard } from "./json-import-card";
import { CsvImportCard } from "./csv-import-card";
import { DoseHistoryImportCard } from "./dose-history-import-card";
import { RecordCsvImportCard } from "./record-csv-import-card";

export {
  EXAMPLE_IMPORT,
  EXAMPLE_IMPORT_DOWNLOAD_HREF,
  EXAMPLE_CSV,
  parseImportJson,
} from "./import-examples";

export function ImportPanel() {
  const { t } = useTranslations();
  return (
    <section
      aria-labelledby="settings-section-import-title"
      className="space-y-4"
    >
      <SectionHeading
        icon={Upload}
        id="settings-section-import-title"
        title={t("settings.sections.export.import.heading")}
        subtitle={t("settings.sections.export.import.description")}
      />
      {/* Columns follow the space the cards actually get, not the viewport:
          with the settings rail and the day panel open, a viewport-keyed
          three-column grid left each card about 150 px wide. */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-4">
        <AppleHealthImportCard />
        <HealthConnectImportCard />
        <HealthConnectRemoteCard />
        <FitImportCard />
        <RecordFileImportCard kind="gadgetbridge" />
        <RecordFileImportCard kind="fhir_bundle" />
        <JsonImportCard />
        <CsvImportCard />
        <DoseHistoryImportCard />
        <RecordCsvImportCard />
      </div>
    </section>
  );
}

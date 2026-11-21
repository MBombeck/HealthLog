/**
 * The name of a document's source system as the person reads it. Product
 * names are proper nouns and stay untranslated; the report schedule and
 * "another system" are prose.
 */
import type { DocumentSourceSystemValue } from "@/lib/validations/document-source-systems";

export function documentSourceName(
  system: DocumentSourceSystemValue,
  t: (key: string) => string,
): string {
  if (system === "PAPERLESS") return "Paperless-ngx";
  if (system === "PAPRA") return "Papra";
  if (system === "REPORT_SCHEDULE") {
    return t("documents.detail.sourceReportSchedule");
  }
  return t("documents.detail.sourceOther");
}

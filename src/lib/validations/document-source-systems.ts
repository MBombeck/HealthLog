/**
 * Where a stored document says it came from: the closed vocabulary of
 * `InboundDocument.sourceSystem` and of the source-key aliases beside it
 * (#1038). Closed on purpose: the detail sheet names each one, and a free string here
 * would be a label the person never chose rendered as if HealthLog vouched for
 * it. OTHER covers any importer that is neither. REPORT_SCHEDULE is the
 * scheduled doctor report, written by the server only: a request may never
 * claim it (`DOCUMENT_UPLOAD_SOURCE_SYSTEMS`).
 */
export const DOCUMENT_UPLOAD_SOURCE_SYSTEMS = [
  "PAPERLESS",
  "PAPRA",
  "OTHER",
] as const;
export const DOCUMENT_SOURCE_SYSTEMS = [
  ...DOCUMENT_UPLOAD_SOURCE_SYSTEMS,
  "REPORT_SCHEDULE",
] as const;
export type DocumentSourceSystemValue =
  (typeof DOCUMENT_SOURCE_SYSTEMS)[number];

/** Narrow a stored `sourceSystem` string to the closed set (null otherwise). */
export function toDocumentSourceSystem(
  value: string | null | undefined,
): DocumentSourceSystemValue | null {
  return (DOCUMENT_SOURCE_SYSTEMS as readonly string[]).includes(value ?? "")
    ? (value as DocumentSourceSystemValue)
    : null;
}

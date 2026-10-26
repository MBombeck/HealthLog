/**
 * The document-vault constants a client component needs, without the schema
 * library: the kind labels, the content-index sources, the list and bulk
 * limits, the coach attachment cap. `src/lib/validations/inbound-documents.ts`
 * builds its zod schemas from these and re-exports them, so server code keeps
 * its import; client code imports from here (a guard holds the documents and
 * Coach routes to that).
 */

/** The document-kind labels (no interpretation — a label only). */
export const INBOUND_DOCUMENT_KINDS = [
  "DOCTOR_REPORT",
  "DISCHARGE_LETTER",
  "LAB_RESULT",
  "IMAGING",
  "PRESCRIPTION",
  "REFERRAL",
  "INSURANCE",
  "VACCINATION",
  "SICK_NOTE",
  "OTHER",
] as const;
export type InboundDocumentKindValue = (typeof INBOUND_DOCUMENT_KINDS)[number];

/**
 * How a document's content index was produced (mirrors the server `source`
 * column). `vision` means an AI provider read the original (the AI-first path);
 * every other value is a provider-free local extraction. The UI reads it to
 * tell an AI-read document from a locally-indexed one — the former already had
 * the richer read, the latter can still be offered "Read with AI".
 */
export const DOCUMENT_CONTENT_INDEX_SOURCES = [
  "vision",
  "text-ocr",
  "local-pdf",
  "local-ocr",
] as const;
export type DocumentContentIndexSourceValue =
  (typeof DOCUMENT_CONTENT_INDEX_SOURCES)[number];

/** True when the index was produced by an AI provider reading the original. */
export function isAiReadSource(
  source: DocumentContentIndexSourceValue | string | null,
): boolean {
  return source === "vision";
}

export const DOCUMENT_LIST_DEFAULT_LIMIT = 50;

/** Max document ids one bulk request may touch. */
export const DOCUMENT_BULK_MAX_IDS = 100;

/** Days a deleted document stays in Recently deleted (see the purge queue). */
export { DOCUMENT_PURGE_GRACE_DAYS } from "@/lib/jobs/document-purge-queue";

/** Max documents attachable to one coach conversation. Bounds prompt size + the
 * numeric-grounding union; five labelled documents is already past the point a
 * chat answer stays useful. */
export const MAX_COACH_ATTACHMENTS = 5;

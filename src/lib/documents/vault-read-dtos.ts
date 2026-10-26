/**
 * The payloads of the vault's side reads: the usage and limits the upload path
 * pre-flights against (`GET /api/documents/inbound/usage`), and Recently
 * deleted (`GET /api/documents/inbound/deleted`, `POST …/{id}/purge`).
 * Re-exported from `@/lib/validations/inbound-documents`, where the other
 * vault DTOs live. Types only.
 */
import type {
  DocumentConditionLinkDto,
  DocumentLinkedProcedureDto,
  DocumentSourceSystemValue,
  InboundDocumentKindValue,
} from "@/lib/validations/inbound-documents";

/** The usage endpoint payload the UI reads before offering an upload. */
export interface DocumentUsageDto {
  usedBytes: number;
  quotaBytes: number;
  maxFileBytes: number;
  acceptedExtensions: string[];
  /**
   * Episodes carrying at least one LIVE document link — the vault filter
   * bar's condition chips. Sourced server-side so a chip exists even when
   * every linked document sits pages deep in the timeline.
   */
  linkedEpisodes: DocumentConditionLinkDto[];
  /**
   * Procedures and surgeries (visits of kind PROCEDURE) carrying at least one
   * LIVE document link — the filter bar's procedure choices, sourced
   * server-side for the same reason as `linkedEpisodes`. Empty when the
   * caller's grant does not cover the visits section, because the label is
   * the visit's own text.
   */
  linkedProcedures: DocumentLinkedProcedureDto[];
  /**
   * Whether the AI "Suggest details" action can run for this caller — true when
   * a provider (vision, or text + local OCR) is configured. The UI hides the
   * action when false so it never offers what the endpoint would 422.
   */
  assistAvailable: boolean;
  /**
   * Content-search index state: whether indexing is available to the caller
   * (`enabled`, same provider precondition as assist), how many live documents
   * are indexed, and the live-document total — so the UI can gauge coverage and
   * offer the "index all documents" backfill.
   */
  contentIndex: {
    enabled: boolean;
    indexedCount: number;
    totalCount: number;
  };
  /**
   * How many of the person's documents sit in Recently deleted (deleted, not
   * yet purged). The vault shows its way into Recently deleted only when this
   * is above zero. Always 0 while acting inside somebody else's record, where
   * Recently deleted is not offered.
   */
  deletedCount: number;
}

/** One document in Recently deleted (`GET /api/documents/inbound/deleted`). */
export interface DeletedDocumentDto {
  id: string;
  kind: InboundDocumentKindValue;
  title: string | null;
  filename: string | null;
  mimeType: string;
  byteSize: number;
  /** User-set filing date (YYYY-MM-DD), or null. */
  documentDate: string | null;
  /** The system an imported document came from, or null. */
  sourceSystem: DocumentSourceSystemValue | null;
  /** When it was deleted (ISO 8601). */
  deletedAt: string;
  /**
   * When the daily purge becomes due for it (ISO 8601): `deletedAt` plus the
   * grace window. The purge runs once a day, so the row goes at the first run
   * after this instant.
   */
  purgeAt: string;
}

/** The Recently deleted list, newest deletion first. */
export interface DeletedDocumentListDto {
  documents: DeletedDocumentDto[];
  /** Days a deleted document stays restorable. */
  graceDays: number;
}

/** Answer of `POST /api/documents/inbound/{id}/purge`. */
export interface DocumentPurgeDto {
  id: string;
  purged: true;
}

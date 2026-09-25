/**
 * v1.25 (W-DOCS-IN) — server-side helpers for the inbound-document store.
 *
 * The AES-256-GCM ↔ `Bytes` codec for `InboundDocument.contentEncrypted` (the
 * raw uploaded document, base64-of-binary → `encrypt()` string → UTF-8 bytes,
 * the same `*Encrypted` format every other sensitive column uses) plus the
 * DTO serialisers that turn the persisted rows into the wire shapes.
 */
import { Buffer } from "node:buffer";

import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { decrypt, decryptBytes, encrypt, encryptBytes } from "@/lib/crypto";
import type {
  ExtractedFact,
  ExtractedFactStatus,
  InboundDocument,
  InboundDocumentStatus,
} from "@/generated/prisma/client";
import { servingClassFor } from "@/lib/documents/upload-policy";
import {
  toDocumentSourceSystem,
  toIndexOutcome,
} from "@/lib/validations/inbound-documents";
import type {
  DocumentConditionLinkDto,
  DocumentEncounterLinkDto,
  DocumentVaccinationLinkDto,
  DocumentContentIndexSourceValue,
  DocumentSummaryStateValue,
  ExtractedFactDto,
  FactData,
  FactProvenance,
  InboundDocumentDetailDto,
  InboundDocumentDto,
  InboundDocumentKindValue,
  InboundFactType,
} from "@/lib/validations/inbound-documents";

/**
 * The two storage codecs `InboundDocument.contentEncrypted` may carry,
 * recorded per row in the explicit `contentCodec` column (never sniffed):
 *   - "base64v1" — the legacy string path (base64-of-binary → `encrypt()`
 *     string → UTF-8 bytes). Pre-vault rows only; kept read-compatible.
 *   - "binary2"  — the binary AES-256-GCM layout (`encryptBytes()`), no
 *     base64 detour. Every new upload writes this.
 */
export const DOCUMENT_CONTENT_CODECS = ["base64v1", "binary2"] as const;
export type DocumentContentCodec = (typeof DOCUMENT_CONTENT_CODECS)[number];

/** The codec every NEW upload is written with. */
export const ACTIVE_DOCUMENT_CODEC: DocumentContentCodec = "binary2";

/**
 * How long a `summaryState: "PENDING"` claim stays credible. The summary job
 * retries twice within minutes; a PENDING whose row has not been touched for
 * an hour is a dead promise (worker crash past the retry budget, or a
 * delete-during-queue then restore). Shared by the read-time heal in
 * `serialiseDocumentDetail` and the hourly persistence sweep
 * (`jobs/document-summary-reaper.ts`) so the two ends cannot drift.
 */
export const SUMMARY_PENDING_TTL_MS = 60 * 60 * 1000;

/** Encrypt the raw document bytes into the `Bytes` payload the schema stores. */
export function encryptDocumentToBytes(bytes: Buffer): Uint8Array<ArrayBuffer> {
  const ciphertext = encrypt(bytes.toString("base64"));
  const encoded = Buffer.from(ciphertext, "utf8");
  const out = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  out.set(encoded);
  return out;
}

/**
 * Decrypt a stored document's `Bytes` payload back to its raw bytes. The exact
 * inverse of `encryptDocumentToBytes`: the column holds `encrypt()`-string
 * UTF-8 bytes whose plaintext is the base64 of the original binary. Throws on a
 * bad / missing key id (fail-closed) — the caller must treat a throw as "cannot
 * serve" and never fall back to returning the ciphertext. The original document
 * is PHI; the owner-scoped download route and the optional extraction action are
 * the only paths that read it.
 */
export function decryptDocumentFromBytes(buf: Uint8Array): Buffer {
  const base64 = decrypt(Buffer.from(buf).toString("utf8"));
  return Buffer.from(base64, "base64");
}

/**
 * Encrypt raw document bytes with the ACTIVE codec (binary2). Returns the
 * `Bytes` payload plus the codec label the row must persist alongside it.
 */
export function encryptDocumentContent(bytes: Buffer): {
  content: Uint8Array<ArrayBuffer>;
  codec: DocumentContentCodec;
} {
  const encrypted = encryptBytes(bytes);
  const out = new Uint8Array(new ArrayBuffer(encrypted.byteLength));
  out.set(encrypted);
  return { content: out, codec: ACTIVE_DOCUMENT_CODEC };
}

/**
 * Decrypt a stored document's payload, dispatching on the row's persisted
 * codec. Fail-closed: an unknown codec value throws — a silent fallback to
 * either codec would either return garbage or mask data corruption.
 */
export function decryptDocumentContent(buf: Uint8Array, codec: string): Buffer {
  if (codec === "base64v1") return decryptDocumentFromBytes(buf);
  if (codec === "binary2") return decryptBytes(Buffer.from(buf));
  throw new Error(`Unknown document content codec '${codec}'`);
}

/**
 * Encrypt a JPEG preview thumbnail into the `Bytes` payload the schema stores
 * (`DocumentThumbnail.thumbnailEncrypted`). Uses the shared AES-256-GCM string
 * codec (base64 of the binary → `encrypt()` string → UTF-8 bytes), the same
 * `encrypt()`-string-as-bytes shape `DocumentContentIndex.textEncrypted` uses —
 * so the standard key-rotation walk (`rotateBytesColumn`) and corpus scan cover
 * it with no binary-codec special-casing. A scanned medical preview is PHI,
 * same posture (versioned key id, fail-closed decrypt) as every other column.
 */
export function encryptThumbnail(jpeg: Buffer): Uint8Array<ArrayBuffer> {
  return encryptToBytes(jpeg.toString("base64"));
}

/**
 * Decrypt a stored thumbnail's `Bytes` payload back to the JPEG. Fail-closed:
 * a bad / missing key id throws — the serve route treats a throw as "cannot
 * serve" and never falls back to the ciphertext.
 */
export function decryptThumbnail(buf: Uint8Array): Buffer {
  return Buffer.from(decryptFromBytes(buf), "base64");
}

/**
 * Encrypt a document's short plain-language summary into the `Bytes` payload
 * the schema stores (`InboundDocument.summaryEncrypted`). Uses the shared
 * AES-256-GCM string codec (`encrypt()` string → UTF-8 bytes), the same shape
 * `DocumentContentIndex.textEncrypted` uses — so the standard key-rotation walk
 * (`rotateBytesColumn`) covers it. The summary is descriptive PHI; same posture
 * (versioned key id, fail-closed decrypt) as every other encrypted column.
 */
export function encryptDocumentSummary(
  summary: string,
): Uint8Array<ArrayBuffer> {
  return encryptToBytes(summary);
}

/** Decrypt a stored document summary's `Bytes` payload. Throws on a bad key. */
export function decryptDocumentSummary(buf: Uint8Array): string {
  return decryptFromBytes(buf);
}

/**
 * Encrypt a staged fact's FHIR-staged payload into the `Bytes` column the
 * schema stores. The structured clinical values (diagnosis text, lab values,
 * medication names, stated codes) are PHI, so they ride the shared AES-256-GCM
 * note codec (JSON → `encrypt()` string → UTF-8 bytes) rather than plaintext
 * JSONB.
 */
export function encryptFactData(data: FactData): Uint8Array<ArrayBuffer> {
  return encryptToBytes(JSON.stringify(data));
}

/** Decrypt a staged fact's payload back to its DTO shape. Throws on bad key. */
export function decryptFactData(buf: Uint8Array): FactData {
  return JSON.parse(decryptFromBytes(buf)) as FactData;
}

/**
 * Encrypt a staged fact's provenance. The verbatim source span is a clinical
 * document excerpt (PHI); encrypted with the same codec as the fact data.
 */
export function encryptFactProvenance(
  provenance: FactProvenance,
): Uint8Array<ArrayBuffer> {
  return encryptToBytes(JSON.stringify(provenance));
}

/**
 * Decrypt a staged fact's provenance back to its DTO shape.
 *
 * Rows written before provenance was anchored carry the model's own echo of the
 * span with no record of whether it ever matched the document. That is exactly
 * the unverified case, so they resolve to `anchored: false`. The stored text is
 * preserved rather than blanked — it is the only provenance those rows have —
 * but the flag stops a consumer presenting it as a checked transcription.
 */
export function decryptFactProvenance(buf: Uint8Array): FactProvenance {
  const raw = JSON.parse(decryptFromBytes(buf)) as Partial<FactProvenance>;
  const anchored = raw.anchored === true;
  return {
    sourceText: typeof raw.sourceText === "string" ? raw.sourceText : "",
    anchored,
    sourceOffset:
      anchored && typeof raw.sourceOffset === "number"
        ? raw.sourceOffset
        : null,
    page: typeof raw.page === "number" ? raw.page : null,
    confidence: typeof raw.confidence === "number" ? raw.confidence : 0,
  };
}

/**
 * The row fields the serialisers read. Deliberately WITHOUT
 * `contentEncrypted`: the list path must never select the blob column
 * (hardening — see the list route's `omit`), so the DTO mappers cannot
 * require it either.
 */
export type SerialisableDocument = Omit<InboundDocument, "contentEncrypted">;

/** Map a persisted document row (+ counts + links) to the list/detail DTO. */
export function serialiseDocument(
  doc: SerialisableDocument,
  counts: { factCount: number; pendingCount: number },
  conditionLinks: DocumentConditionLinkDto[] = [],
  hasContentIndex = false,
  contentIndexSource: DocumentContentIndexSourceValue | null = null,
  hasThumbnail = false,
  encounterLinks: DocumentEncounterLinkDto[] = [],
): InboundDocumentDto {
  return {
    id: doc.id,
    kind: doc.kind as InboundDocumentKindValue,
    title: doc.title,
    filename: doc.filename,
    mimeType: doc.mimeType,
    byteSize: doc.byteSize,
    status: doc.status as InboundDocumentStatus,
    providerType: doc.providerType,
    reportDate: doc.reportDate
      ? doc.reportDate.toISOString().slice(0, 10)
      : null,
    documentDate: doc.documentDate
      ? doc.documentDate.toISOString().slice(0, 10)
      : null,
    errorReason: doc.errorReason,
    factCount: counts.factCount,
    pendingCount: counts.pendingCount,
    conditionLinks,
    encounterLinks,
    servingClass: servingClassFor(doc.mimeType),
    hasContentIndex,
    contentIndexSource: hasContentIndex ? contentIndexSource : null,
    // Refs #776 — the attempt record travels on every DTO so the detail view
    // can explain a missing index. Outcome only surfaces while there IS no
    // index: once indexed, the last failure is history, not status.
    lastIndexAttemptAt: doc.lastIndexAttemptAt
      ? doc.lastIndexAttemptAt.toISOString()
      : null,
    lastIndexOutcome: hasContentIndex
      ? null
      : toIndexOutcome(doc.lastIndexOutcome),
    hasThumbnail,
    sourceSystem: toDocumentSourceSystem(doc.sourceSystem),
    sourceId: doc.sourceSystem ? doc.sourceId : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** Map a persisted staged-fact row to the review DTO. */
export function serialiseFact(fact: ExtractedFact): ExtractedFactDto {
  return {
    id: fact.id,
    factType: fact.factType as InboundFactType,
    status: fact.status as ExtractedFactStatus,
    confidence: fact.confidence,
    needsReview: fact.needsReview,
    data: decryptFactData(fact.dataEncrypted),
    provenance: decryptFactProvenance(fact.provenanceEncrypted),
    committedRecordId: fact.committedRecordId,
    committedRecordType: fact.committedRecordType,
  };
}

/** Assemble the detail DTO (document + its staged facts + links). */
export function serialiseDocumentDetail(
  doc: SerialisableDocument,
  facts: ExtractedFact[],
  conditionLinks: DocumentConditionLinkDto[] = [],
  hasContentIndex = false,
  contentIndexSource: DocumentContentIndexSourceValue | null = null,
  hasThumbnail = false,
  encounterLinks: DocumentEncounterLinkDto[] = [],
  vaccinationLinks: DocumentVaccinationLinkDto[] | null = [],
): InboundDocumentDetailDto {
  const pendingCount = facts.filter((f) => f.status === "PENDING").length;
  // `factCount` excludes REJECTED facts (a rejected fact is discarded, not part
  // of the document's tally) so the badge matches the list query.
  const factCount = facts.filter((f) => f.status !== "REJECTED").length;
  // Decrypt the persisted background summary for the detail view. A decrypt
  // failure (a rotated-away legacy key) degrades to no summary rather than
  // failing the whole detail load — the field is descriptive, not load-bearing,
  // and the ciphertext is never returned (fail-closed to null).
  let summary: string | null = null;
  // The stored state is the truth EXCEPT when the ciphertext will not open: a
  // READY row we cannot decrypt has no summary to show, and reporting READY
  // would leave the view rendering a heading over nothing. Degrade to
  // UNAVAILABLE so what the user is told matches what they can see.
  let summaryState: DocumentSummaryStateValue = doc.summaryState;
  if (doc.summaryEncrypted && doc.summaryEncrypted.byteLength > 0) {
    try {
      summary = decryptDocumentSummary(doc.summaryEncrypted);
    } catch {
      summary = null;
      summaryState = "UNAVAILABLE";
    }
  } else if (summaryState === "READY") {
    // READY with no ciphertext should be unreachable; trust the bytes, not the
    // flag, rather than promising a summary that is not there.
    summaryState = "UNAVAILABLE";
  } else if (
    summaryState === "PENDING" &&
    Date.now() - doc.updatedAt.getTime() > SUMMARY_PENDING_TTL_MS
  ) {
    // A PENDING older than the TTL is a dead promise — the job died past its
    // retry budget and nothing will resolve it. Degrade to UNAVAILABLE so the
    // sheet stops saying "generating" forever and offers the manual generate
    // action instead. The hourly reaper persists the same heal
    // (`jobs/document-summary-reaper.ts`); this read-time arm just makes the
    // very next open honest without waiting for the tick.
    summaryState = "UNAVAILABLE";
  }
  return {
    ...serialiseDocument(
      doc,
      { factCount, pendingCount },
      conditionLinks,
      hasContentIndex,
      contentIndexSource,
      hasThumbnail,
      encounterLinks,
    ),
    facts: facts.map(serialiseFact),
    vaccinationLinks,
    summary,
    summaryGeneratedAt: doc.summaryGeneratedAt
      ? doc.summaryGeneratedAt.toISOString()
      : null,
    summaryState,
  };
}

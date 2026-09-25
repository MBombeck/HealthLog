/**
 * OpenAPI route table for the documents library (`/api/documents/inbound/*`).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The confirm +
 * edit + list request bodies reuse the runtime schemas from
 * `@/lib/validations/inbound-documents` so the wire contract stays
 * single-source.
 *
 * The v1.25.x library inverts the original OCR-inbox: upload is STORE-ONLY and
 * provider-free (a file is always filable, encrypted at rest); AI extraction is
 * a separate, opt-in action on an already-stored document. Extraction
 * reproduces what the document states (stated codes/status only) into a staging
 * area — it never interprets or diagnoses. Nothing reaches the structured
 * stores until the confirm route commits the user's approvals; a low-confidence
 * fact fails closed.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import {
  documentBulkSchema,
  documentChatRequestSchema,
  documentUpdateSchema,
  inboundConfirmSchema,
  inboundFactEditSchema,
  DOCUMENT_SOURCE_ID_MAX,
  DOCUMENT_SOURCE_SYSTEMS,
  DOCUMENT_SUMMARY_STATES,
  INBOUND_DOCUMENT_KINDS,
  INBOUND_DOCUMENT_STATUSES,
} from "@/lib/validations/inbound-documents";

import { aiExtractionRefusals } from "./ai-extraction-refusals";
import { aiCapabilityState } from "./profile";
import {
  dataEnvelope,
  errorEnvelope,
  idempotencyKeyParameter,
  idempotentWrite,
  recordRefusal,
  stdResponses,
} from "./shared";

const kindEnum = z.enum(INBOUND_DOCUMENT_KINDS);
const statusEnum = z.enum(INBOUND_DOCUMENT_STATUSES);

// ─── Chat about a document (P4) — response shapes ──────────────────────────

const documentChatConversationSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    messageCount: z.number(),
  })
  .meta({ id: "DocumentChatConversation" });

const documentChatMessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    createdAt: z.string(),
    providerType: z.string().nullable(),
    tokensUsed: z.number().nullable(),
    model: z.string().nullable(),
  })
  .meta({ id: "DocumentChatMessage" });

const documentChatDetailSchema = documentChatConversationSchema
  .extend({
    messages: z.array(documentChatMessageSchema),
    summary: z.string().nullable(),
  })
  .meta({ id: "DocumentChatDetail" });

const documentChatListSchema = z
  .object({
    conversations: z.array(documentChatConversationSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "DocumentChatList" });

// Zod 4's `.meta()` returns a NEW instance carrying the id rather than
// annotating in place, so each annotated schema is bound to a const and the
// route table below references that const — a bare call would register nothing.
const inboundConfirmRequest = inboundConfirmSchema.meta({
  id: "InboundConfirmRequest",
  description:
    "The approve/reject decisions a human made on the review screen. Each names a staged fact by id. Approved facts are committed to the structured stores (labs / conditions / medications) through their normal create paths; rejected facts are discarded. A fact still flagged `needsReview` (below the confidence floor, never edited) cannot be approved — it is reported back as `needsReview`. No `userId` field — it is narrowed from the session; every fact id is re-scoped to the document + caller.",
});

const inboundFactEditRequest = inboundFactEditSchema.meta({
  id: "InboundFactEditRequest",
  description:
    "A correction to a staged fact before approval (fixes OCR / units / dates / codes). Discriminated by `factType` so the edit cannot change the fact's resource type. A successful edit clears `needsReview` — the values become user-asserted.",
});

const documentUpdateRequest = documentUpdateSchema.meta({
  id: "DocumentUpdateRequest",
  description:
    "Metadata edit for a stored document: `title` (user label; null clears it), `kind` (category), `documentDate` (user filing date, YYYY-MM-DD; null clears it), `episodeIds` (REPLACE-SET of condition links — the document's links become exactly this set; an empty array unlinks everything; every id must be a live episode of the caller or the whole request answers 404), `encounterIds` (the same replace-set semantics over the caller's visits), `vaccinationIds` (the same replace-set semantics over the caller's vaccination doses, up to 100 so one childhood record can be filed against a whole primary schedule). At least one field required. No `userId` field — narrowed from the session and fed to the Prisma `where` with the row id.",
});

const documentBulkRequest = documentBulkSchema.meta({
  id: "DocumentBulkRequest",
  description:
    "One bulk action over up to 100 owner-scoped documents: `setKind` (requires `kind`), `linkEpisode` / `unlinkEpisode` (require `episodeId`), `linkEncounter` / `unlinkEncounter` (require `encounterId`), `delete` (tombstone, undo-able for 30 days), `restore` (clear tombstone). Partial failures never abort the batch — see the per-id result array.",
});

const factProvenance = z.object({
  sourceText: z.string(),
  anchored: z.boolean(),
  sourceOffset: z.number().nullable(),
  page: z.number().nullable(),
  confidence: z.number(),
});

const extractedFact = z
  .object({
    id: z.string(),
    factType: z.enum(["CONDITION", "OBSERVATION", "MEDICATION_STATEMENT"]),
    status: z.enum(["PENDING", "APPROVED", "REJECTED"]),
    confidence: z.number(),
    needsReview: z.boolean(),
    data: z.record(z.string(), z.unknown()),
    provenance: factProvenance,
    committedRecordId: z.string().nullable(),
    committedRecordType: z.string().nullable(),
  })
  .meta({
    id: "ExtractedFact",
    description:
      "One STATED fact transcribed from the document, FHIR-staged (Condition / Observation / MedicationStatement) with per-field provenance + a confidence gate. STATED status only — codes (SNOMED/ICD-10/LOINC/RxNorm/ATC) are present only when the document wrote them; no range-flag, no inferred links. `needsReview` is true when the fact scored below the confidence floor (it cannot be approved until edited).",
  });

const conditionLink = z
  .object({
    episodeId: z.string(),
    name: z.string(),
  })
  .meta({
    id: "DocumentConditionLink",
    description:
      "A link to one of the caller's illness/condition episodes. `name` is the episode's user-facing label.",
  });

const encounterLink = z
  .object({
    encounterId: z.string(),
    kind: z.string(),
    occurredAt: z.string().nullable(),
  })
  .meta({
    id: "DocumentEncounterLink",
    description:
      "A link to one of the caller's visits — \"this letter belongs to that appointment\". `kind` is the visit-kind ENUM CONSTANT rather than a rendered name: unlike a condition label, which is the person's own words, a visit kind is one of eight closed values whose human name the reader's own bundle owns, so publishing the constant is what lets a German reader and an English one each see it named correctly.",
  });

const vaccinationLink = z
  .object({
    vaccinationId: z.string(),
    occurredAt: z.string().nullable(),
    catalogSlug: z.string().nullable(),
    vaccineName: z.string().nullable(),
  })
  .meta({
    id: "DocumentVaccinationLink",
    description:
      "A link to one of the caller's vaccination doses — \"this page records that dose\". `catalogSlug` is the catalogue entry when this release still knows the dose's slug, for the reader's own bundle to name; null is the signal to show `vaccineName`, the person's own wording. The same table the dose's own `/api/vaccinations/{id}/links` writes from the other end.",
  });

const inboundDocument = z
  .object({
    id: z.string(),
    kind: kindEnum,
    title: z.string().nullable(),
    filename: z.string().nullable(),
    mimeType: z.string(),
    byteSize: z.number(),
    status: statusEnum,
    providerType: z.string().nullable(),
    reportDate: z.string().nullable(),
    documentDate: z.string().nullable(),
    errorReason: z.string().nullable(),
    factCount: z.number(),
    pendingCount: z.number(),
    conditionLinks: z.array(conditionLink),
    encounterLinks: z.array(encounterLink),
    servingClass: z.enum(["inline", "attachment"]),
    hasContentIndex: z.boolean(),
    contentIndexSource: z
      .enum(["vision", "text-ocr", "local-pdf", "local-ocr"])
      .nullable(),
    lastIndexAttemptAt: z.string().nullable(),
    lastIndexOutcome: z
      .enum([
        "local-empty",
        "local-unsupported",
        "decrypt-error",
        "raster-failed",
        "provider-error",
        "pdf-needs-anthropic",
        "empty-transcription",
      ])
      .nullable(),
    hasThumbnail: z.boolean(),
    sourceSystem: z.enum(DOCUMENT_SOURCE_SYSTEMS).nullable(),
    sourceId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({
    id: "InboundDocument",
    description:
      "A stored document. The raw bytes are stored encrypted at rest and never returned; this is the metadata + staging summary. `status` is STORED for a freshly uploaded file (no extraction run). `title` is the user label (plaintext); `documentDate` is the user filing date; `reportDate` is the model-transcribed date (null until extraction runs). `servingClass` says how `/original` delivers the file — render inline (`inline`) or download-only (`attachment`); render/download by it, never by MIME guess. `hasContentIndex` is true when the document has a content-search index (auto-indexed on upload); `contentIndexSource` says how that index was produced — `vision` means an AI provider read the original, the other values are provider-free local extractions, and it is null when `hasContentIndex` is false. `lastIndexAttemptAt` is when the most recent index attempt finished (successful or not; null when none ran); `lastIndexOutcome` says why that attempt produced no index, and is null when the attempt succeeded or none ran. `hasThumbnail` is true when a preview thumbnail has been rendered in the background (fetch it from `/api/documents/inbound/{id}/thumbnail`); false means no preview yet or an unsupported type — show a placeholder. `sourceSystem` / `sourceId` say where an imported document came from and its id there (both null for a document added in HealthLog); treat an unknown `sourceSystem` as OTHER when decoding. Treat an unknown `kind` value as OTHER when decoding.",
  });

const inboundDocumentDetail = inboundDocument
  .extend({
    facts: z.array(extractedFact),
    vaccinationLinks: z.array(vaccinationLink).nullable().meta({
      description:
        "Vaccination doses this document is filed against. Null when the caller acts inside somebody else's record under a grant that does not cover the health background the doses live in: the page is shared, the doses are not, and an empty list would claim the page records none.",
    }),
    summary: z.string().nullable(),
    summaryGeneratedAt: z.string().nullable(),
    summaryState: z.enum(DOCUMENT_SUMMARY_STATES),
  })
  .meta({
    id: "InboundDocumentDetail",
    description:
      'A stored document plus its staged facts. `summary` is a short (3-4 sentence) plain-language description of WHAT the document is, generated once and then served from storage; it is descriptive only, never a diagnosis. `summaryGeneratedAt` is when it was generated (null until then). `summaryState` says what became of it, because a null `summary` on its own is ambiguous: NONE = never attempted (the `documentsAutoAiRead` opt-in was off at upload, reading documents with AI was closed for the record at upload, or the document predates it — no backfill reaches these), PENDING = a job is enqueued or running, READY = stored and returned in `summary`, WITHHELD = generated but blocked by the outbound safety screen and therefore never returned as text, UNAVAILABLE = attempted and could not produce one (no vision provider, spent budget, withdrawn consent, unreadable file, provider error). Only PENDING may be presented as "being generated"; WITHHELD and UNAVAILABLE are both re-attemptable via POST `/api/documents/inbound/{id}/summary`. Treat an unknown value as UNAVAILABLE when decoding.',
  });

const listResponse = z
  .object({
    documents: z.array(inboundDocument),
    nextCursor: z.string().nullable(),
  })
  .meta({
    id: "InboundDocumentList",
    description:
      "A page of documents plus an opaque `nextCursor` (the id to pass back as `cursor` for the next page; null when the list is exhausted).",
  });

const confirmResponse = z
  .object({
    approved: z.array(
      z.object({
        factId: z.string(),
        recordType: z.string(),
        recordId: z.string(),
      }),
    ),
    rejected: z.array(z.string()),
    needsReview: z.array(z.string()),
    failed: z.array(z.object({ factId: z.string(), reason: z.string() })),
  })
  .meta({
    id: "InboundConfirmResponse",
    description:
      "The outcome per decision: `approved` (committed, with the new record ref), `rejected` (discarded), `needsReview` (refused — edit first, fail-closed), `failed` (a per-fact commit miss, e.g. a numeric observation with no unit).",
  });

const kindValues = [...INBOUND_DOCUMENT_KINDS];

const documentUploadReceipt = z
  .object({
    id: z.string().nullable(),
    duplicate: z.boolean(),
    deleted: z.literal(true).optional(),
  })
  .meta({
    id: "DocumentUploadReceipt",
    description:
      "What an upload answers instead of the stored row. A narrow `documents:write` token always gets this shape (`duplicate: false` on 201, `true` on 200): a credential that can only add files learns whether a file is stored, not its title, filename or links. Every caller gets it when the upload's source key belongs to a document the owner DELETED (`deleted: true`, 200, nothing stored); `id` is the tombstoned row, or null once the 30-day purge removed it.",
  });

// Shared by the POST 200 (duplicate) and 201 (created) responses — the
// envelope id must be registered exactly once.
const documentUploadEnvelope = dataEnvelope(
  z.union([inboundDocument, documentUploadReceipt]),
  "DocumentUploadEnvelope",
);

export const inboundDocumentPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/documents/inbound": {
    get: {
      tags: ["Documents"],
      summary: "List stored documents",
      description:
        "The caller's stored documents with title/filename search, category filter, a `documentDate` range, sort, and keyset pagination. Owner-scoped; gated on the opt-in `inboundDocuments` module.",
      parameters: [
        {
          name: "q",
          in: "query",
          required: false,
          schema: { type: "string", maxLength: 100 },
          description: "Case-insensitive search over title + filename.",
        },
        {
          name: "kind",
          in: "query",
          required: false,
          style: "form",
          explode: true,
          schema: {
            type: "array",
            items: { type: "string", enum: kindValues },
          },
          description:
            "Category filter — OR inside the facet. Repeat the parameter (or send a comma-separated value).",
        },
        {
          name: "episodeId",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Only documents linked to this illness/condition episode.",
        },
        {
          name: "encounterId",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Only documents linked to this visit.",
        },
        {
          name: "year",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1900, maximum: 9999 },
          description:
            "Only documents whose filing date falls in this calendar year (UTC). Takes precedence over from/to.",
        },
        {
          name: "from",
          in: "query",
          required: false,
          schema: { type: "string", format: "date" },
          description: "Inclusive lower bound on documentDate (YYYY-MM-DD).",
        },
        {
          name: "to",
          in: "query",
          required: false,
          schema: { type: "string", format: "date" },
          description: "Inclusive upper bound on documentDate (YYYY-MM-DD).",
        },
        {
          name: "sort",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["documentDate", "createdAt", "title"],
            default: "documentDate",
          },
        },
        {
          name: "order",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["asc", "desc"], default: "desc" },
        },
        {
          name: "cursor",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Keyset cursor (the `nextCursor` from a prior page).",
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 50,
          },
        },
      ],
      responses: {
        ...recordRefusal(),
        "200": {
          description: "A page of documents.",
          content: {
            "application/json": {
              schema: dataEnvelope(listResponse, "InboundDocumentListEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      parameters: [
        idempotencyKeyParameter,
        {
          name: "sourceSystem",
          in: "query",
          required: false,
          schema: { type: "string", enum: [...DOCUMENT_SOURCE_SYSTEMS] },
          description:
            "Import source key, first half. Sent here instead of (or agreeing with) the form field, it is checked before the body is read or the hourly allowance is charged.",
        },
        {
          name: "sourceId",
          in: "query",
          required: false,
          schema: { type: "string", maxLength: DOCUMENT_SOURCE_ID_MAX },
          description:
            "Import source key, second half. Both halves or neither; half a key is 422.",
        },
      ],
      tags: ["Documents"],
      summary: "Store a document (no extraction)",
      description:
        'STORE-ONLY upload. Stores the raw document ENCRYPTED at rest with `status: STORED` and runs NO extraction — provider-free, no AI consent / budget / egress. A file is always filable, even with no document-scan provider configured. `multipart/form-data`: a `file` plus optional `title`, `kind`, `documentDate` (YYYY-MM-DD), and repeated `episodeIds` form fields (pre-link to the caller\'s illness/condition episodes). Accepted types (magic-byte sniffed, never the wire Content-Type): PDF/JPEG/PNG/WebP/GIF render inline; Office (docx/xlsx/pptx/doc/xls/ppt), text/CSV/Markdown/RTF, TIFF, HEIC/HEIF, XML/JSON are stored verbatim and served download-only. HEIC is stored as-is but attachment-only — prefer transcoding to JPEG client-side for inline preview parity. Error contract: `413` with `meta.reason = "fileTooLarge"` (+ `maxFileBytes`) or `"quotaExceeded"` (+ `quotaBytes`, `usedBytes`); `415` with `meta.reason = "unsupportedType"`. A same-user duplicate (same bytes) returns 200 + `meta.duplicate: true` with the existing row — not an error. `Idempotency-Key` honoured. Read `GET /api/documents/inbound/usage` for the effective limits before offering an upload. AI extraction is a separate opt-in action — see `POST /api/documents/inbound/{id}/extract`.\n\n' +
        "**Importing from another system (v1.39.2).** Optional `sourceSystem` (`PAPERLESS`, `PAPRA`, `OTHER`) and `sourceId` (its id there, printable, up to 128 characters; needs `sourceSystem`) key the upload. A re-send with a known key is a duplicate: 200 with the live row (`meta.duplicate: true`), or, when the owner DELETED that document, 200 with `data.deleted: true` and `meta.deleted: true` and nothing stored; this holds after the 30-day purge too. The key may instead ride the query string (`?sourceSystem=…&sourceId=…`): it is then answered before the body is read and before the hourly allowance is charged, so a re-send of a document already held costs neither; a key in both places must agree (else 422). A key that is answered with an existing document by its bytes is remembered for that document, so deleting it keeps that key deleted too. `OTHER` is one shared namespace per account: two different systems both sent as `OTHER` must not reuse each other\'s ids. An upload answered as a duplicate or as deleted hands its slot of the hourly allowance back. `aiRead=defer` holds back automatic AI reading for this upload: the thumbnail and a local text index still run, the summary and lab staging do not, and the document stays out of the summary catch-up until the person reads it with AI or generates its summary. Absent, behaviour is unchanged.\n\n" +
        "**Narrow token.** Also reachable with a `documents:write` Bearer (minted at `POST /api/tokens/documents`), which reaches only this route and the source-key lookup `GET /api/documents/inbound/source`. Such a caller draws on a bucket of its own, keyed on the token (default 120 an hour, `DOCUMENT_UPLOAD_LIMIT_PER_HOUR`, clamped 1-1000; the 429 carries `Retry-After` and `X-RateLimit-*`), and gets a `DocumentUploadReceipt` instead of the stored row; its 413 `quotaExceeded` carries no `quotaBytes` / `usedBytes`. The response is an untagged union (row or receipt) on purpose: a discriminator would need a new field on the row every existing client decodes. A cookie or wildcard caller keeps the 60-an-hour per-user bucket and the full row. With the vault module off the answer is 403 `module.disabled` for every caller.",
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: z.object({
              file: z.string().meta({
                format: "binary",
                description:
                  "The document. Validated by magic-byte MIME sniff, not the wire Content-Type.",
              }),
              title: z
                .string()
                .optional()
                .meta({ description: "Optional user label." }),
              kind: kindEnum
                .optional()
                .meta({ description: "Optional category." }),
              documentDate: z.string().optional().meta({
                description:
                  "Optional user filing date (YYYY-MM-DD). Defaults to the upload day when omitted so the library sort/filter/display stay aligned.",
              }),
              episodeIds: z.array(z.string()).optional().meta({
                description:
                  "Optional condition pre-links (repeat the field per id). Every id must be a live episode of the caller.",
              }),
              encounterIds: z.array(z.string()).optional().meta({
                description:
                  "Optional visit pre-links (repeat the field per id). Every id must be a live visit of the caller; an unknown one refuses the upload rather than dropping the link the person asked for.",
              }),
              sourceSystem: z.enum(DOCUMENT_SOURCE_SYSTEMS).optional().meta({
                description:
                  "Optional. The system an imported document comes from. Shown on the detail view.",
              }),
              sourceId: z.string().max(DOCUMENT_SOURCE_ID_MAX).optional().meta({
                description:
                  "Optional. The document's id in `sourceSystem`; requires it. Unique per account across live and deleted documents.",
              }),
              aiRead: z.enum(["defer"]).optional().meta({
                description:
                  "Optional. `defer` holds back automatic AI reading for this upload (local index and thumbnail only).",
              }),
            }),
          },
        },
      },
      responses: {
        ...idempotentWrite(),
        "200": {
          description:
            "Duplicate — the same bytes, or the same source key, are already stored: the existing row (a `DocumentUploadReceipt` for a `documents:write` token), with `meta.duplicate: true` at the envelope level. When the source key belongs to a document the owner deleted: a receipt with `deleted: true` and `meta.deleted: true`, nothing stored.",
          content: {
            "application/json": {
              schema: documentUploadEnvelope,
            },
          },
        },
        "201": {
          description:
            "The stored document (a `DocumentUploadReceipt` for a `documents:write` token).",
          content: {
            "application/json": {
              schema: documentUploadEnvelope,
            },
          },
        },
        "413": {
          description:
            "Too large: `meta.reason` is `fileTooLarge` (with `maxFileBytes`) or `quotaExceeded` (with `quotaBytes` + `usedBytes`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "415": {
          description:
            'Unsupported or unidentifiable type (`meta.reason = "unsupportedType"`). Executables, HTML/SVG, and generic archives are always refused.',
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/documents/inbound/source": {
    get: {
      tags: ["Documents"],
      summary: "Look up an import source key",
      description:
        "Whether the vault already holds a document under this import source key, so an importer can skip a document before downloading it from the source system. Answers exactly what an upload with the same key would: `known`, the document `id` (null once a deleted document was purged), and whether the owner `deleted` it. Checks the document's own key, keys remembered for it when an import sent the same bytes under another key, and the keys of purged documents. Reachable with a `documents:write` Bearer (the scope's second and last route) or a cookie session; stores nothing. 5000 lookups an hour per token (per person for a session); gated on the `inboundDocuments` module.",
      parameters: [
        {
          name: "sourceSystem",
          in: "query",
          required: true,
          schema: { type: "string", enum: [...DOCUMENT_SOURCE_SYSTEMS] },
        },
        {
          name: "sourceId",
          in: "query",
          required: true,
          schema: { type: "string", maxLength: DOCUMENT_SOURCE_ID_MAX },
        },
      ],
      responses: {
        "200": {
          description: "The answer for this key.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z
                  .object({
                    known: z.boolean(),
                    id: z.string().nullable(),
                    deleted: z.boolean(),
                  })
                  .meta({ id: "DocumentSourceLookup" }),
                "DocumentSourceLookupEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/documents/inbound/capability": {
    get: {
      tags: ["Documents"],
      summary: "Probe document-AI availability + egress",
      description:
        'Cheap probe (no provider call) the vault uses to decide the AI transport and whether to warn before a read leaves the machine. Resolved over the DOCUMENT provider order (local-first, ChatGPT-subscription OAuth last), so `mode` / `pdfSupported` / `egress` match exactly what the document AI routes do. `egress` is vendor-blind: `"local"` (a self-hosted model — the document never leaves the operator\'s machine) or `"external"` (a third-party AI service). The vault shows a per-egress notice before any external document read; sending a document to any external provider also requires an active `ai_extraction` or `ai_full` consent receipt. `ai` is the `documentAi` capability for the record: when the operator turned reading documents off, the module is off, or the record is somebody else\'s, `available` is false with a null `reason` and `ai.reason` says why. A missing consent receipt leaves the read offered (`ai.reason = "consent_required"`), because the read is where the person is asked for it.',
      responses: {
        "200": {
          description: "Document-AI capability flags + egress class.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z
                  .object({
                    available: z.boolean(),
                    mode: z.enum(["vision", "text"]).nullable(),
                    reason: z
                      .enum(["no-provider", "enable-local-ocr"])
                      .nullable(),
                    pdfSupported: z.boolean(),
                    egress: z.enum(["local", "external"]).nullable(),
                    ai: aiCapabilityState,
                  })
                  .meta({ id: "DocumentAiCapability" }),
                "DocumentAiCapabilityEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/documents/inbound/usage": {
    get: {
      tags: ["Documents"],
      summary: "Storage usage + effective limits",
      description:
        "The caller's vault usage and effective limits: `usedBytes` (every non-purged row — tombstones inside the 30-day undo grace still count), `quotaBytes` (per-user override ?? instance default), `maxFileBytes` (admin-tunable per-file cap), `acceptedExtensions` for picker `accept` lists, and `linkedEpisodes` (episodes carrying at least one live document link — the condition-filter chips). Read this before offering an upload.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Usage + limits.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z
                  .object({
                    usedBytes: z.number(),
                    quotaBytes: z.number(),
                    maxFileBytes: z.number(),
                    acceptedExtensions: z.array(z.string()),
                    linkedEpisodes: z.array(
                      z.object({
                        episodeId: z.string(),
                        name: z.string(),
                      }),
                    ),
                    assistAvailable: z
                      .boolean()
                      .describe(
                        "Whether a document read can run for this record now: a provider can serve it and the `documentAi` capability is not closed by the operator, the module or the sharing grant. The same answer as `available` on GET /api/documents/inbound/capability.",
                      ),
                    contentIndex: z.object({
                      enabled: z.boolean(),
                      indexedCount: z.number(),
                      totalCount: z.number(),
                    }),
                  })
                  .meta({ id: "DocumentUsage" }),
                "DocumentUsageEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/documents/inbound/bulk": {
    post: {
      tags: ["Documents"],
      summary: "Bulk action over documents",
      description:
        "Applies one action to up to 100 owner-scoped documents and returns a per-id result array — a partial failure never aborts the batch. `error` is `notFound` (unknown / foreign / tombstoned where liveness is required) or `conflict` (restore blocked by a live duplicate of the same bytes).",
      requestBody: {
        required: true,
        content: { "application/json": { schema: documentBulkRequest } },
      },
      responses: {
        "200": {
          description: "Per-id outcomes.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z
                  .object({
                    results: z.array(
                      z.object({
                        id: z.string(),
                        ok: z.boolean(),
                        error: z.string().nullable(),
                      }),
                    ),
                  })
                  .meta({ id: "DocumentBulkResponse" }),
                "DocumentBulkEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/documents/inbound/{id}": {
    get: {
      tags: ["Documents"],
      summary: "Get a document + its staged facts",
      description:
        "The document plus every staged fact for the review screen. Owner-scoped.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Document detail.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                inboundDocumentDetail,
                "InboundDocumentDetailEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Documents"],
      summary: "Edit a document's metadata",
      description:
        "Rename / recategorise / set the user filing date on a stored document. Owner-scoped; no mass assignment. Returns the updated document + its staged facts.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: { "application/json": { schema: documentUpdateRequest } },
      },
      responses: {
        "200": {
          description: "The updated document.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                inboundDocumentDetail,
                "InboundDocumentUpdateEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Documents"],
      summary: "Discard a document",
      description:
        "Soft-deletes the document + its staging. Facts already approved into the structured stores are independent rows and are NOT affected.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Discarded.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ id: z.string(), discarded: z.boolean() }),
                "InboundDiscardEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/documents/inbound/{id}/restore": {
    post: {
      tags: ["Documents"],
      summary: "Restore a discarded document",
      description:
        'Clears the soft-delete tombstone within the 30-day undo grace. 409 when the tombstone is already purged (the undo window is over) or when an identical live document blocks the restore (`meta.reason = "duplicateExists"`). Restoring an already-live document is a no-op success.',
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "The restored document + its staged facts.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                inboundDocumentDetail,
                "InboundRestoreEnvelope",
              ),
            },
          },
        },
        "409": {
          description:
            "Not restorable: purged past the grace window, or an identical live document exists.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/documents/inbound/{id}/original": {
    get: {
      tags: ["Documents"],
      summary: "View / download the original document",
      description:
        "Decrypts and serves the raw uploaded document (the bytes stored encrypted at rest under `InboundDocument.contentEncrypted`). Owner-scoped + gated on the opt-in `inboundDocuments` module. Serving posture follows the document's `servingClass`: inline types (PDF/JPEG/PNG/WebP/GIF) come with their true Content-Type, `Content-Disposition: inline`, `nosniff`, and a `Content-Security-Policy: sandbox` header; attachment types (Office/text/TIFF/HEIC/XML/JSON) ALWAYS come as `application/octet-stream` + `Content-Disposition: attachment` + `nosniff` — never inline. A non-ASCII filename is carried via RFC 5987 `filename*`. Fails closed (500) on a decrypt error — it never returns the ciphertext.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        ...recordRefusal(),
        "200": {
          description:
            "The decrypted original document bytes. Inline types carry the stored MIME type; attachment types are served as application/octet-stream.",
          content: {
            "application/pdf": {
              schema: { type: "string", format: "binary" },
            },
            "image/*": {
              schema: { type: "string", format: "binary" },
            },
            "application/octet-stream": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/documents/inbound/{id}/thumbnail": {
    get: {
      tags: ["Documents"],
      summary: "View the document preview thumbnail",
      description:
        "Decrypts and serves the document's small JPEG preview thumbnail (~320px long edge), rendered in the background from the original and stored encrypted at rest under `DocumentThumbnail.thumbnailEncrypted`. Owner-scoped + gated on the opt-in `inboundDocuments` module. Always `Content-Type: image/jpeg` + `nosniff` + `Cache-Control: private, no-store`; loaded as an `<img>` subresource. 404 when no thumbnail exists yet (freshly uploaded / still rendering / unsupported type) — the caller shows a placeholder. Fails closed (500) on a decrypt error — it never returns the ciphertext.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        ...recordRefusal(),
        "200": {
          description: "The decrypted JPEG preview thumbnail bytes.",
          content: {
            "image/jpeg": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/documents/inbound/{id}/extract": {
    post: {
      tags: ["Documents"],
      summary: "Extract facts from a stored document",
      description:
        'Optional AI enhancement on an already-stored document. Runs the dedicated OCR/vision provider over the stored original and stages STRUCTURED FACTS for review. Answers under the `documentAi` capability (403 with the capability envelope when it is closed), then rate / budget gated. With no provider configured this returns 422 (`documents.inbound.providerUnsupported`, with `meta.capability` and `meta.reason = "no_provider"`) — the stored document is untouched, only the enhancement fails. Three modes: VISION (empty body) decrypts and scans the stored original (PDF needs an Anthropic vision provider); TEXT (`application/json`, opt-in local OCR) `{ mode: "text", text }` structures browser-OCR\'d text; STORED (`application/json`) `{ mode: "stored" }` structures the document\'s own stored extracted text (its content index) — the manual recovery for a skipped/failed automatic staging run, 422 `documents.inbound.notIndexed` when no stored text exists. Extraction reproduces what the document states — it never interprets. Nothing reaches the structured stores here; the confirm route is the only write path.',
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: z
              .union([
                z.object({
                  mode: z.literal("text"),
                  text: z.string(),
                  kind: kindEnum.optional(),
                }),
                z.object({
                  mode: z.literal("stored"),
                }),
              ])
              .meta({ id: "InboundExtractRequest" }),
          },
        },
      },
      responses: {
        "200": {
          description: "The document with its newly staged facts.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                inboundDocumentDetail,
                "InboundExtractEnvelope",
              ),
            },
          },
        },
        "409": {
          description:
            "Re-extraction refused: at least one fact on this document is already APPROVED. `meta.errorCode` = `documents.inbound.alreadyPartlyConfirmed`. Re-extracting would sever committed-record provenance and duplicate committed records, so the user must finish reviewing or discard the document first.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...aiExtractionRefusals("documentAi"),
        ...stdResponses,
      },
    },
  },
  "/api/documents/inbound/{id}/suggest": {
    post: {
      tags: ["Documents"],
      summary: "Suggest filing metadata (drafts only)",
      description:
        'Optional AI assist on an already-stored document. Runs ONE provider call over the stored original (VISION, empty body) or browser-OCR\'d text (TEXT, `application/json` `{ mode: "text", text }`, opt-in local OCR) and returns a `{ title, kind, documentDate }` DRAFT for the edit form. Answers under the `documentAi` capability (403 with the capability envelope when it is closed), then rate / budget gated (shares the per-user document-AI bucket with extract/summary/index — default 6/hour, operator-tunable via `DOCUMENT_AI_LIMIT_PER_HOUR`; a slot is only consumed when the request reaches the provider, and the 429 carries `Retry-After`, the `X-RateLimit-Limit` / `-Remaining` / `-Reset` triple, and `meta.retryAt`). WRITES NOTHING — never stages facts, never flips status; the user reviews and saves. 422 (`documents.inbound.providerUnsupported`) with no provider configured. Never interprets or diagnoses; the title is a neutral filing label.',
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: z.object({
              mode: z.literal("text"),
              text: z.string(),
              kind: kindEnum.optional(),
            }),
          },
        },
      },
      responses: {
        "200": {
          description: "The filing-metadata suggestion (drafts).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z
                  .object({
                    suggestions: z.object({
                      title: z.string().nullable(),
                      kind: kindEnum.nullable(),
                      documentDate: z.string().nullable(),
                    }),
                  })
                  .meta({ id: "DocumentSuggestResponse" }),
                "DocumentSuggestEnvelope",
              ),
            },
          },
        },
        ...aiExtractionRefusals("documentAi"),
        ...stdResponses,
      },
    },
  },
  "/api/documents/inbound/{id}/summary": {
    post: {
      tags: ["Documents"],
      summary: "Summarise or transcribe a document",
      description:
        'On-demand description of a stored document. `?mode=summary` (default) returns a short plain-language summary of WHAT the document is; it remains transient unless `persist=true` fills the empty stored-summary slot, while `persist=true&replace=true` explicitly replaces an existing summary. `?mode=text` returns transient raw transcribed text. Neither result reaches coach memory, snapshots, structured stores, or the search index. The summary is descriptive only and never a diagnosis. Same VISION (empty body) / TEXT (`application/json` `{ mode: "text", text }`, opt-in local OCR) dispatch as extract. Answers under the `documentAi` capability (403 with the capability envelope when it is closed), then rate / budget gated. 422 `documents.inbound.providerUnsupported` with no provider.',
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        {
          name: "mode",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: ["summary", "text"],
            default: "summary",
          },
          description:
            "`summary` (plain-language description) or `text` (raw).",
        },
        {
          name: "persist",
          in: "query",
          required: false,
          schema: { type: "boolean", default: false },
          description:
            "For summary mode only: persist into an empty stored-summary slot.",
        },
        {
          name: "replace",
          in: "query",
          required: false,
          schema: { type: "boolean", default: false },
          description:
            "With `persist=true`, explicitly replace an existing stored summary.",
        },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: z.object({
              mode: z.literal("text"),
              text: z.string(),
              kind: kindEnum.optional(),
            }),
          },
        },
      },
      responses: {
        "200": {
          description:
            "The summary and its persistence outcome, or transient extracted text.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z
                  .object({
                    summary: z.string().optional(),
                    text: z.string().optional(),
                    persistence: z
                      .enum(["stored", "withheld", "failed"])
                      .optional(),
                  })
                  .meta({ id: "DocumentSummaryResponse" }),
                "DocumentSummaryEnvelope",
              ),
            },
          },
        },
        ...aiExtractionRefusals("documentAi"),
        ...stdResponses,
      },
    },
  },
  "/api/documents/inbound/{id}/index": {
    post: {
      tags: ["Documents"],
      summary: "Build / refresh the content-search index",
      description:
        "Populates or refreshes one document's content-search index so search matches INSIDE its body. VISION (empty body) decrypts the stored original and runs one provider transcription (answers under the `documentAi` capability — 403 with the capability envelope when it is closed, including a missing `ai_extraction` / `ai_full` receipt for a provider that leaves the machine — then rate / budget gated); TEXT (`application/json` `{ mode: \"text\", text }`, opt-in local OCR) indexes browser-OCR'd text with no provider egress and stays available with AI off, so search keeps working. Persists ONLY AES-256-GCM ciphertext of the text plus opaque HMAC token hashes — no plaintext body, no plaintext token. Idempotent; re-indexing overwrites in place. A successful index continues into the same lab auto-staging the background worker performs (still-STORED lab-looking document with no facts, both modules on, provider + consent eligible); `labFactsStaged` reports how many facts were staged PENDING for review — confirmation stays the only write into Labs.",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: z.object({
              mode: z.literal("text"),
              text: z.string(),
              kind: kindEnum.optional(),
            }),
          },
        },
      },
      responses: {
        "200": {
          description: "The document was indexed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z
                  .object({
                    documentId: z.string(),
                    indexed: z.boolean(),
                    tokenCount: z.number(),
                    labFactsStaged: z
                      .number()
                      .describe(
                        "How many lab facts the index run auto-staged for review (0 when the document is not a lab report, staging was not eligible, or facts already exist). Staged facts are PENDING — the confirm route remains the only write into Labs.",
                      ),
                  })
                  .meta({ id: "DocumentIndexResponse" }),
                "DocumentIndexEnvelope",
              ),
            },
          },
        },
        ...aiExtractionRefusals("documentAi"),
        ...stdResponses,
      },
    },
  },
  "/api/documents/inbound/{id}/chat": {
    post: {
      tags: ["Documents"],
      summary: "Chat about a document (streaming reply)",
      description:
        "v1.27.33 — sends a user turn and streams a grounded prose reply about ONE stored document as Server-Sent Events (`text/event-stream`, not JSON: one `data: <json>\\n\\n` frame per event). Frame `type` is `token` (a chunk of reply text), `done` (`{ type, conversationId, messageId, usage? }`), or `error` (`{ type, code, message }`); HTTP status is 200 even for a provider/refusal outcome (dispatch on the `error` frame). The reply is grounded ONLY in the document's indexed text — NO health snapshot, NO tools, NO other document. The document text is fenced as untrusted DATA (prompt-injection defence); the inbound message + every prior turn are injection-screened and the reply is dose/risk-screened + numerically grounded against the document's own figures. Available only for a content-indexed document (422 `documents.inbound.notIndexed` otherwise). Answers under the `documentAi` capability (403 with the capability envelope when it is closed; `consent.ai.required` for a provider that leaves the machine without an `ai_extraction` / `ai_full` receipt), budget- and rate-limited; no provider is the `documents.chat.provider.none` error frame. Reading the history (GET) stays available whatever the capability says. Omitting `conversationId` starts a new thread. Renders as plain text on the client (no markdown). Auth via cookie or Bearer.",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: documentChatRequestSchema },
        },
      },
      responses: {
        "200": {
          description:
            "Server-Sent Events stream of `token` / `done` / `error` frames.",
          content: {
            "text/event-stream": {
              schema: {
                type: "string",
                description:
                  "SSE frames: `data: <json>\\n\\n`. See the operation description for the per-`type` frame shapes.",
              },
            },
          },
        },
        ...aiExtractionRefusals("documentAi"),
        ...stdResponses,
      },
    },
    get: {
      tags: ["Documents"],
      summary: "Read a document's chat history",
      description:
        "v1.27.33 — with `conversationId`, returns that one thread's messages (decrypted server-side, oldest-first, document- and owner-scoped); without it, the paginated list of the document's chat threads for the sheet's rail. A foreign / unknown id maps to 404 (never 403). Auth via cookie or Bearer.",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        {
          name: "conversationId",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "When set, returns that thread's messages.",
        },
        {
          name: "cursor",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "List pagination cursor (id of the last item).",
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 50 },
        },
      ],
      responses: {
        "200": {
          description:
            "Either the conversation detail (with `messages`) or the paginated conversation list for the document.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z
                  .union([documentChatDetailSchema, documentChatListSchema])
                  .meta({ id: "DocumentChatHistoryResponse" }),
                "DocumentChatHistoryEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/documents/inbound/reindex": {
    post: {
      tags: ["Documents"],
      summary: "Index all documents for content search",
      description:
        "Enqueues a background job that content-indexes the caller's not-yet-indexed documents (one provider transcription each, bounded + resumable). Gated on the module, the `documentAi` capability (403 with the capability envelope), a configured vision provider (422 `documents.inbound.providerUnsupported` otherwise), and an `ai_extraction` / `ai_full` consent receipt when that provider leaves the machine (403 `consent.ai.required`). Returns immediately; the work runs off-request on the queue, which re-checks the capability before every read.",
      responses: {
        "200": {
          description:
            "How many live documents the enqueued backfill still has to index (0 when everything is indexed or no job was created).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z
                  .object({ enqueued: z.number().int().nonnegative() })
                  .meta({ id: "DocumentReindexResponse" }),
                "DocumentReindexEnvelope",
              ),
            },
          },
        },
        ...aiExtractionRefusals("documentAi"),
        ...stdResponses,
      },
    },
  },
  "/api/documents/inbound/{id}/facts/{factId}": {
    patch: {
      tags: ["Documents"],
      summary: "Edit a staged fact before approval",
      description:
        "Corrects OCR / units / dates / codes on a pending fact. Clears `needsReview` (the values become user-asserted). The fact's resource type cannot change.",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        {
          name: "factId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: { "application/json": { schema: inboundFactEditRequest } },
      },
      responses: {
        "200": {
          description: "The updated fact.",
          content: {
            "application/json": {
              schema: dataEnvelope(extractedFact, "ExtractedFactEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/documents/inbound/{id}/confirm": {
    post: {
      tags: ["Documents"],
      summary: "Confirm the review decisions",
      description:
        "The ONLY write path out of staging. Commits the user's approvals into the structured stores (labs / conditions / medications) and discards rejections. A low-confidence fact that was never edited cannot be approved (fail-closed). Idempotent (Idempotency-Key). Audits as `documents.inbound.confirm`.",
      parameters: [
        idempotencyKeyParameter,
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: { "application/json": { schema: inboundConfirmRequest } },
      },
      responses: {
        ...idempotentWrite(),
        "200": {
          description: "Per-decision outcome.",
          content: {
            "application/json": {
              schema: dataEnvelope(confirmResponse, "InboundConfirmEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};

/**
 * OpenAPI route table for Lab-OCR ingestion (`/api/labs/ocr/*`).
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The commit
 * request reuses the runtime `ocrCommitSchema` from
 * `@/lib/validations/labs-ocr` so the wire contract stays single-source. The
 * extract upload is a `multipart/form-data` binary body (documented inline);
 * the response shapes are declared here.
 *
 * iOS coordination: server-authoritative — the iOS client consumes the
 * committed `LabResult` rows and never re-OCRs. A future native capture would
 * POST this same extract/commit contract. `source` carries the new value
 * `"OCR"` on rows written through the commit route.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import { ocrCommitSchema } from "@/lib/validations/labs-ocr";

import { aiExtractionRefusals } from "./ai-extraction-refusals";
import { aiRunAccepted } from "./ai-run-accepted";
import { aiCapabilityState } from "./profile";
import {
  dataEnvelope,
  idempotencyKeyParameter,
  idempotentWrite,
  stdResponses,
} from "./shared";

// `.meta()` CLONES in Zod 4 rather than annotating in place, so the returned
// schema has to be captured and referenced. A bare `schema.meta({...})`
// statement registers nothing and the component id it names never reaches the
// emitted document.
const ocrCommitRequest = ocrCommitSchema.meta({
  id: "OcrCommitRequest",
  description:
    "The rows a human confirmed on the Lab-OCR review screen. Each row is EITHER numeric (`value` + `unit`, optional reference bounds) OR qualitative (`valueText`) — exactly one. `analyte` drives a resolve-or-mint of the user-scoped biomarker; `takenAt` is a backdatable ISO instant. No `userId` field — it is narrowed from the session. 1..400 rows (`analyte` and `valueText` up to 120 characters, `unit` up to 40). The route skips a row that duplicates a live reading (same analyte + day + value). The optional `encounterId` files the panel against a visit the caller owns — ONE link per written result row, so a marker re-run on a different day belongs to its own visit; always optional, and a link that could not be made never fails the commit.",
});

const capabilityResponse = z
  .object({
    available: z.boolean(),
    mode: z.enum(["vision", "text"]).nullable(),
    reason: z.enum(["no-provider", "enable-local-ocr"]).nullable(),
    pdfSupported: z.boolean(),
    ai: aiCapabilityState,
  })
  .meta({
    id: "OcrCapabilityResponse",
    description:
      "Whether the caller's configured AI provider can ingest a lab report (drives the UI's scan affordance). `mode` is `vision` when the provider reads the image directly, `text` when the image is OCR'd in-browser and only the extracted text is sent (opt-in local OCR for text-only providers), or null when unavailable. `reason` explains an unavailable state; `pdfSupported` is true when the provider reads PDFs natively (Anthropic) or the server-side rasterizer can render the pages for any other vision provider. `ai` is the `labsOcr` capability for the record: when the operator turned reading documents off, the labs module is off, or the record is somebody else\'s, `available` is false with a null `reason` and `ai.reason` says why. A missing consent receipt leaves the scan offered (`ai.reason = \"consent_required\"`), because the scan is where the person is asked for it. No provider call is made.",
  });

const extractConfidence = z.object({
  analyte: z.number(),
  value: z.number(),
  unit: z.number(),
  range: z.number(),
});

const extractedRow = z
  .object({
    analyte: z.string(),
    value: z.number().nullable(),
    valueText: z.string().nullable(),
    unit: z.string().nullable(),
    referenceLow: z.number().nullable(),
    referenceHigh: z.number().nullable(),
    referenceText: z.string().nullable().meta({
      description:
        'The reference range EXACTLY as printed on the report, verbatim ("3,5 - 5,0", "< 116", "bis 5,0", "negativ"). `referenceLow` / `referenceHigh` carry the same window reduced to numbers WHEN it reduces to numbers; this field carries it either way, so a window stated in words is not lost between the report and the reading.',
    }),
    takenAt: z.string().nullable(),
    confidence: extractConfidence,
    biomarkerMatch: z.enum(["new", "existing"]),
    markerUnit: z.string().nullable().meta({
      description:
        "The unit the matched marker is tracked in, or null when the marker does not exist yet (it will adopt this row's unit). A row whose `unit` differs from it is converted on commit when the marker's analyte is known and the pair is in the unit-conversion registry; otherwise the commit skips it with `reason: unit_mismatch`, and the review screen marks it before Save.",
    }),
    markerAnalyteKey: z.string().nullable().meta({
      description:
        "The analyte the matched marker is (the catalog slug, e.g. `fasting-glucose` or `ldl`, or a registry-only key such as `urea`), or null when the marker does not exist yet or its name matches none. With `markerUnit` it tells a client whether a row in another unit can be converted on commit.",
    }),
    duplicateOf: z.string().nullable(),
    biomarkerId: z
      .string()
      .nullable()
      .optional()
      .describe(
        "v1.43 — the marker this row was matched to automatically (by name, by an alias of the account, or by a catalogue abbreviation); null without a match.",
      ),
    matchKind: z
      .enum(["name", "alias", "catalog"])
      .nullable()
      .optional()
      .describe("v1.43 — how `biomarkerId` was found."),
    suggestions: z
      .array(
        z.object({
          biomarkerId: z.string(),
          name: z.string(),
          unit: z.string(),
          matchKind: z.enum(["catalog", "similar"]),
        }),
      )
      .max(3)
      .optional()
      .describe(
        "v1.43 — up to three markers to choose from when nothing matched; empty when `biomarkerId` is set.",
      ),
  })
  .meta({
    id: "OcrExtractedRow",
    description:
      "One proposed reading transcribed from the upload. UNTRUSTED model output annotated server-side: `biomarkerMatch` flags whether the analyte links an existing catalog marker; `duplicateOf` is the id of a live reading this row likely duplicates (the review row defaults to unchecked when set); `confidence` is the model's per-field self-score (low fields are flagged for the human). Nothing is written until the commit route confirms.",
  });

export const ocrExtractResponse = z
  .object({
    reportDate: z.string().nullable(),
    providerType: z.string(),
    rows: z.array(extractedRow),
    pageCoverage: z
      .object({
        read: z.number().int().positive(),
        total: z.number().int().positive(),
      })
      .optional()
      .describe(
        "Present only when a PDF ran past the pages a scan reads (20): the rows come from the first `read` of `total` pages. Absent when the whole document was read.",
      ),
    truncated: z
      .object({ pages: z.array(z.number().int().positive()) })
      .optional()
      .describe(
        "Present only when a read stopped at the provider's output limit. The rows that read produced before the cut are kept; readings after the cut may be missing. `pages` names the pages whose read was cut, or is empty when the report went to the provider as one read (a photo, a one-page PDF, OCR'd text).",
      ),
    unreadPages: z
      .array(z.number().int().positive())
      .optional()
      .describe(
        "Present only when part of a multi-part read produced nothing: the provider failed partway through, or a part's reply could not be read; or, on a server that cannot render PDF pages, a PDF read by its text layer had pages without one (scanned pages). The rows of the other parts are kept; these pages are not in `rows`. Empty when the parts were not pages (OCR'd text).",
      ),
    stoppedBy: z
      .enum(["budget", "unavailable", "error"])
      .optional()
      .describe(
        "Present only when the scan stopped before its last read for a reason other than the provider: `budget`, the day's AI budget ran out (every read after the first is reserved on its own); `unavailable`, AI was turned off for the record while it ran (the wire is re-checked before every read); `error`, that check or the reservation failed itself, so the scan stopped rather than read on unchecked. The pages it did not reach are in `unreadPages`.",
      ),
    rowsCapped: z
      .object({
        kept: z.number().int().positive(),
        found: z.number().int().positive(),
      })
      .optional()
      .describe(
        "Present only when the report held more readings than one scan carries (400): `rows` holds the first `kept` of the `found` readings.",
      ),
  })
  .meta({
    id: "OcrExtractResponse",
    description:
      "The proposed rows for the human review screen, served by `GET /api/ai-runs/{id}` for a `LABS_OCR_EXTRACT` run. A PDF of more than one page is read a page at a time, each rendered page sent with its text layer as a hint the image overrules, and the pages merged in order, a reading an earlier page already listed listed once. Never written to the person's record; the commit route is the only write. A run in which no read produced a single complete row fails with 422 `labs.ocr.outputLimit` when the reads stopped at the provider's output limit, else `labs.ocr.extractFailed`; OCR'd text too long for the reads the deadline allows is refused up front with 422 `labs.ocr.tooLarge`. A scan stopped before any read produced a row answers with the stop: 429 `labs.ocr.budgetExceeded` when the day's budget refused a further read; the wire's own refusal (its status and code, e.g. 403 `consent.ai.required`, `assistant.disabled.*`, `module.disabled`) when AI was turned off for the record; 500 `aiRuns.failed` when the check before a read failed. A scan stopped after some rows succeeds with them and names the stop in `stoppedBy` (`budget`, `unavailable`, `error`) and the pages it did not reach in `unreadPages`.",
  });

const committedRow = z
  .object({
    id: z.string(),
    biomarkerId: z.string().nullable(),
    panel: z.string().nullable(),
    analyte: z.string(),
    value: z.number().nullable(),
    valueText: z.string().nullable(),
    unit: z.string(),
    converted: z.boolean(),
    sourceValue: z.number().nullable(),
    sourceUnit: z.string().nullable(),
    referenceLow: z.number().nullable(),
    referenceHigh: z.number().nullable(),
    catalogReferenceLow: z.number().nullable(),
    catalogReferenceHigh: z.number().nullable(),
    sourceReferenceLow: z.number().nullable(),
    sourceReferenceHigh: z.number().nullable(),
    sourceReferenceText: z.string().nullable(),
    printedReferenceText: z.string().nullable(),
    referenceOrigin: z.enum(["source", "catalog", "none"]),
    referenceDivergesFromCatalog: z.boolean(),
    takenAt: z.string(),
    source: z.string(),
    hasNote: z.boolean(),
    rangeStatus: z.enum(["in-range", "below", "above", "unknown"]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({
    id: "OcrCommittedLabResult",
    description:
      "A written reading. Its reference window resolves exactly as it does on `/api/labs` — see `LabResult`. `converted`, `sourceValue` and `sourceUnit` say when the row's unit was converted into its marker's and what the report printed; for a converted row the printed range text is in `printedReferenceText` (in `sourceUnit`) and `sourceReferenceText` is null.",
  });

const commitResponse = z
  .object({
    inserted: z.array(committedRow),
    skipped: z.array(
      z.object({
        analyte: z.string(),
        reason: z
          .enum(["duplicate", "unit_mismatch", "unknown_biomarker"])
          .meta({
            description:
              "`duplicate`: the row matched a live reading at commit time. `unit_mismatch`: the row states a unit other than the one its marker is tracked in and the pair cannot be converted, so it was not written. A pair that can be converted is written in the marker's unit and reported with `converted: true`. `unknown_biomarker` (v1.43): the row named a `biomarkerId` that is not one of the record's markers.",
          }),
      }),
    ),
    outcome: z.enum(["empty", "failed", "partial", "success"]).meta({
      description:
        "How the commit reads, resolved from the counts rather than the status code. `success` only when every confirmed row was written; `partial` when some were skipped; `failed` when nothing was written and at least one row was skipped; `empty` when there was nothing to write.",
    }),
  })
  .meta({
    id: "OcrCommitResponse",
    description:
      'The rows written (`source: "OCR"`), those skipped (commit-time duplicates, or a unit that differs from that of the marker), and the resolved outcome.',
  });

export const ocrPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/labs/ocr/capability": {
    get: {
      tags: ["Labs"],
      summary: "Probe Lab-OCR availability",
      description:
        "Cheap probe (no provider call) the Labs UI uses to decide whether to show the scan affordance. Reports whether the caller's configured AI provider can read images, why not, and whether PDFs are accepted.",
      responses: {
        "200": {
          description: "Capability flags.",
          content: {
            "application/json": {
              schema: dataEnvelope(capabilityResponse, "OcrCapabilityEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/labs/ocr/extract": {
    post: {
      tags: ["Labs"],
      summary: "Extract lab readings from a photo, PDF, or OCR'd text",
      description:
        "Read-only (NOT idempotent) extraction. Two modes by content-type. VISION (`multipart/form-data`): a `file` (JPEG/PNG/WebP, or PDF — read natively on Anthropic, else rasterized to page images for any other vision provider; ≤ 12 MiB) is run through the user's vision-capable provider; the upload is never logged. TEXT (`application/json`, opt-in local OCR): the browser OCR's the image (tesseract.js) and POSTs `{ mode: \"text\", text }` — only the extracted text reaches the server, so a text-only provider (e.g. ChatGPT-OAuth) reaches the same review/commit flow. Both modes are model work and answer under the `labsOcr` capability (the operator's reading-documents switch, the labs module, and — because a lab report is a document — an active `ai_extraction` or `ai_full` consent receipt for any provider that leaves the machine, checked for the provider actually picked: the first vision-capable entry in vision mode, the chain head in text mode). No provider is 422 `labs.ocr.providerUnsupported`; text mode without the local-OCR opt-in is 422 `labs.ocr.localOcrDisabled`. Then both pass a per-user hourly rate bucket (default 6, operator-tunable via `LABS_OCR_LIMIT_PER_HOUR`; a slot is only consumed when the scan reaches the provider, and the 429 carries `Retry-After`, the `X-RateLimit-*` triple and `meta.retryAt`) and the per-day token budget, and the read is queued: since v1.40 the route answers 202 with a run id and `GET /api/ai-runs/{id}` serves the proposed rows (`OcrExtractResponse`) for the mandatory human review screen. The upload or text is held encrypted in the run until it is read, then dropped; the run is deleted an hour after it ends. Nothing is written to the record — the commit route is the only write. A file too large is 413 `labs.ocr.fileTooLarge`, an unknown type 415 `labs.ocr.fileType`, both before anything is queued. Extracted content is treated as untrusted (prompt-injection); the review step is the safety boundary.",
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: z.object({
              file: z.string().meta({
                format: "binary",
                description:
                  "The lab-report image or PDF. Validated by magic-byte MIME sniff, not the wire Content-Type.",
              }),
            }),
          },
          "application/json": {
            schema: z
              .object({
                mode: z.literal("text"),
                text: z.string().meta({
                  description:
                    "The in-browser-OCR'd lab-report text. The raw image never reaches the server in this mode.",
                }),
              })
              .meta({ id: "OcrTextExtractRequest" }),
          },
        },
      },
      responses: {
        ...aiRunAccepted,
        ...aiExtractionRefusals("labsOcr"),
        ...stdResponses,
      },
    },
  },
  "/api/labs/ocr/commit": {
    post: {
      parameters: [idempotencyKeyParameter],
      tags: ["Labs"],
      summary: "Commit confirmed Lab-OCR rows",
      description:
        'Writes ONLY the rows the human confirmed on the review screen. Each row resolves-or-mints a user-scoped biomarker and creates a `LabResult` with `source: "OCR"`; a row that duplicates a live reading, or states a unit other than that of its marker, is skipped (`skipped[].reason`). Idempotent (Idempotency-Key). Audits as `labs.ocr.commit`. `userId` is narrowed from the session, never a body field.',
      requestBody: {
        required: true,
        content: { "application/json": { schema: ocrCommitRequest } },
      },
      responses: {
        ...idempotentWrite(),
        "200": {
          description: "Inserted + skipped rows.",
          content: {
            "application/json": {
              schema: dataEnvelope(commitResponse, "OcrCommitEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};

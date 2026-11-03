/**
 * v1.18.9 — Lab-OCR ingestion contract.
 *
 * A self-hoster with a vision-capable AI provider uploads a photo / PDF of a
 * paper lab report; the provider transcribes the readings as structured JSON;
 * the rows land on a MANDATORY human-review screen; only the user-confirmed
 * rows write to `lab_results` (+ a biomarker create/link).
 *
 * This module holds:
 *   - `extractedLabsSchema` — the schema the provider's JSON is validated
 *     against in the extract route (UNTRUSTED model output).
 *   - `ocrCommitSchema` — the request body of the commit route (the rows the
 *     human confirmed). No `userId` field — it is always narrowed from the
 *     session.
 *
 * The DTO types the routes return + the UI consumes are derived here so the
 * three layers agree on one shape.
 */
import type { AiCapabilityState } from "@/lib/ai/capabilities/types";
import { z } from "zod/v4";

import { LAB_UNIT_DESCRIPTION } from "@/lib/labs/dimensionless";
import type { WrittenOutcome } from "@/lib/outcome/written-outcome";

import { validateEntryInstant } from "@/lib/validations/entry-instant";
import { isoDateTime } from "@/lib/validations/datetime";

/**
 * Max rows a single scan / commit may carry. A single panel is ~30 analytes,
 * but a multi-page hospital report with several panels runs to 150-300
 * readings, and a scan that finds more than this keeps the first rows rather
 * than losing all of them (`rowsCapped` on the extract response).
 */
export const OCR_MAX_ROWS = 400;

/**
 * The field lengths a confirmed row may carry, shared by the commit schema and
 * the review screen so a row the screen lets through is one the commit takes.
 * The same bounds the manual lab-entry schema applies.
 */
export const OCR_ANALYTE_MAX = 120;
export const OCR_VALUE_TEXT_MAX = 120;
export const OCR_UNIT_MAX = 40;

/**
 * Far-past floor for a lab sample, mirroring `createLabResultSchema`'s
 * `takenAtField` (a self-hoster legitimately backdates an old paper report).
 */
const LAB_TAKEN_AT_MAX_AGE_MS = 50 * 365.25 * 24 * 60 * 60 * 1000;

/** Shared committed-row `takenAt`: ISO string → Date, plausibility-bounded. */
const takenAtField = validateEntryInstant(
  isoDateTime({
    offset: false,
    message: "takenAt must be an ISO 8601 datetime",
  }).transform((s) => new Date(s)),
  {
    maxAgeMs: LAB_TAKEN_AT_MAX_AGE_MS,
    pastMessage: "Sample date is too far in the past",
  },
);

/**
 * Per-field extraction confidence (0..1). The model self-reports how legible
 * each field was; the review screen pre-flags any field below the threshold
 * so the human double-checks it. Bounded + coerced defensively because this is
 * untrusted model output.
 */
const confidenceScore = z.number().min(0).max(1).catch(0);

const extractedConfidenceSchema = z
  .object({
    analyte: confidenceScore.default(0),
    value: confidenceScore.default(0),
    unit: confidenceScore.default(0),
    range: confidenceScore.default(0),
  })
  // The model may omit the block entirely — default every field to 0 (treated
  // as "flag for review") rather than rejecting the whole row.
  .default({ analyte: 0, value: 0, unit: 0, range: 0 });

/**
 * One row as the PROVIDER returns it (untrusted). Liberal on shape: a missing
 * field is null, a date may be absent. The review step is the safety boundary —
 * the server never acts on this beyond mapping it to the DTO.
 *
 * `value` XOR `valueText`: a reading is numeric OR qualitative. The model is
 * instructed to set exactly one, but a malformed pair is tolerated here and
 * resolved on the review screen rather than 422-ing the whole extraction.
 */
export const extractedRowSchema = z.object({
  analyte: z.string().trim().min(1).max(200),
  value: z.number().finite().nullable().catch(null),
  valueText: z.string().trim().min(1).max(200).nullable().catch(null),
  unit: z.string().trim().max(80).nullable().catch(null),
  referenceLow: z.number().finite().nullable().catch(null),
  referenceHigh: z.number().finite().nullable().catch(null),
  /**
   * The reference range EXACTLY as printed, verbatim. The two numeric bounds
   * above can only carry a window that reduces to two numbers; a report that
   * prints "bis 5,0" or "negativ" states a window all the same, and this is
   * what keeps it instead of dropping it.
   */
  referenceText: z.string().trim().max(120).nullable().catch(null),
  takenAt: z.string().nullable().catch(null),
  confidence: extractedConfidenceSchema,
});

/**
 * The full JSON envelope the provider returns. Rows are checked one by one
 * (`parseExtractedLabs`), so one malformed row costs that row and not the
 * whole read.
 */
export const extractedLabsSchema = z.object({
  reportDate: z.string().nullable().catch(null),
  rows: z.array(z.unknown()),
});

export type ExtractedRow = z.infer<typeof extractedRowSchema>;

export interface ExtractedLabs {
  reportDate: string | null;
  rows: ExtractedRow[];
  /** Rows the model returned that did not fit the row schema (no name, …). */
  droppedRows: number;
}

/**
 * Validate an untrusted provider envelope. Null when the envelope itself is
 * not the documented shape (no `rows` array); otherwise every row that fits
 * the row schema, in order, and a count of the ones that did not.
 */
export function parseExtractedLabs(json: unknown): ExtractedLabs | null {
  const envelope = extractedLabsSchema.safeParse(json);
  if (!envelope.success) return null;
  const rows: ExtractedRow[] = [];
  let droppedRows = 0;
  for (const raw of envelope.data.rows) {
    const row = extractedRowSchema.safeParse(raw);
    if (row.success) rows.push(row.data);
    else droppedRows += 1;
  }
  return { reportDate: envelope.data.reportDate, rows, droppedRows };
}

/**
 * The per-row DTO the EXTRACT route returns to the client. Carries the model's
 * extracted fields plus server-computed annotations:
 *   - `biomarkerMatch`: whether the analyte links an existing catalog marker
 *     or will mint a new one.
 *   - `duplicateOf`: the id of an existing live `lab_results` row that already
 *     records this analyte+date+value (the review row defaults to unchecked).
 *   - `takenAt`: normalised to the row date ?? reportDate (ISO) when present.
 */
export interface OcrExtractedRowDto {
  analyte: string;
  value: number | null;
  valueText: string | null;
  unit: string | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  /** The reference range as printed on the report, verbatim. */
  referenceText: string | null;
  takenAt: string | null;
  confidence: {
    analyte: number;
    value: number;
    unit: number;
    range: number;
  };
  biomarkerMatch: "new" | "existing";
  /**
   * The unit the matched marker is tracked in, or null for a marker that does
   * not exist yet (it will adopt this row's unit). Lets the review screen say
   * so before Save when the scanned unit differs.
   */
  markerUnit: string | null;
  /**
   * Which analyte the matched marker is (catalog slug or registry-only key), or null
   * when the marker is new or none is known. With `markerUnit` it tells the
   * review screen whether a row in another unit can be converted on Save.
   */
  markerAnalyteKey: string | null;
  duplicateOf: string | null;
  /**
   * v1.43 — the marker the row was matched to automatically: by its
   * name, an alias of the account, or a catalog abbreviation. Null when none.
   */
  biomarkerId: string | null;
  matchKind: "name" | "alias" | "catalog" | null;
  /** Up to three markers to choose from when nothing matched; else empty. */
  suggestions: Array<{
    biomarkerId: string;
    name: string;
    unit: string;
    matchKind: "catalog" | "similar";
  }>;
}

export interface OcrExtractResponseDto {
  reportDate: string | null;
  providerType: string;
  rows: OcrExtractedRowDto[];
  /**
   * Present only when a PDF was longer than the pages the scan reads
   * (`RASTER_MAX_PAGES`): the rows come from the first `read` of `total`
   * pages, and the review screen says so.
   */
  pageCoverage?: { read: number; total: number };
  /**
   * Present only when a read stopped at the provider's output limit. The rows
   * the read produced before the cut are kept; readings after it may be
   * missing. `pages` names the pages whose read was cut, or is empty when the
   * report went to the provider as one read.
   */
  truncated?: { pages: number[] };
  /**
   * Present only when the provider failed partway through a multi-page read
   * (the rows of the pages before the failure are kept), or when a PDF read
   * by its text layer on a server that cannot render had pages without one:
   * these pages were not read.
   */
  unreadPages?: number[];
  /**
   * Present only when the scan stopped before its last read for a reason
   * other than the provider: `budget`, the day's AI budget ran out;
   * `unavailable`, AI was turned off for the record while it ran; `error`,
   * the check before a read failed, so the scan stopped rather than read on
   * unchecked. The pages it did not reach are in `unreadPages`.
   */
  stoppedBy?: "budget" | "unavailable" | "error";
  /**
   * Present only when the report held more readings than one scan carries
   * (`OCR_MAX_ROWS`): the first `kept` of `found` are in `rows`.
   */
  rowsCapped?: { kept: number; found: number };
}

/**
 * One row the human CONFIRMED on the review screen, sent to the commit route.
 * Reuses the `createLabResultSchema` field discipline: numeric XOR qualitative,
 * a unit required for a numeric reading, sane reference bounds. `analyte` is
 * always present (the review screen requires a name); the commit route always
 * resolves-or-mints a biomarker by `(userId, lower(analyte))`.
 */
const requiredAnalyte = z.string().trim().min(1).max(OCR_ANALYTE_MAX);
const referenceLow = z.number().finite().optional();
const referenceHigh = z.number().finite().optional();

export const ocrCommitRowSchema = z
  .object({
    analyte: requiredAnalyte,
    panel: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .or(z.literal("").transform(() => undefined)),
    value: z.number().finite().optional(),
    valueText: z.string().trim().min(1).max(OCR_VALUE_TEXT_MAX).optional(),
    unit: z
      .string()
      .trim()
      .min(1)
      .max(OCR_UNIT_MAX)
      .optional()
      .describe(LAB_UNIT_DESCRIPTION),
    referenceLow,
    referenceHigh,
    /**
     * The window the scanned report printed for this row. Confirmed by the
     * human on the review screen alongside everything else, and written onto
     * the reading rather than only used to seed a new catalog marker.
     */
    referenceText: z
      .string()
      .trim()
      .max(120)
      .optional()
      .or(z.literal("").transform(() => undefined)),
    takenAt: takenAtField,
    /**
     * v1.43 — the marker the person chose for this row on the review
     * screen. The row is written under it whatever `analyte` says; an id that
     * is not one of the record's markers skips the row (`unknown_biomarker`).
     */
    biomarkerId: z.string().trim().min(1).max(64).optional(),
    /**
     * With `biomarkerId`: remember `analyte` as another spelling of that
     * marker, so the next report with the same name matches on its own.
     * Default true. Ignored when the name is the marker's own.
     */
    rememberAlias: z.boolean().optional(),
  })
  // Numeric XOR qualitative: exactly one of value / valueText.
  .refine((d) => (d.value !== undefined) !== (d.valueText !== undefined), {
    message:
      "Provide exactly one of value (numeric) or valueText (qualitative)",
    path: ["value"],
  })
  // A numeric reading needs a unit (the catalog otherwise has nothing to mint
  // it with); a qualitative reading needs none.
  .refine((d) => d.valueText !== undefined || d.unit !== undefined, {
    message: "unit is required for a numeric reading",
    path: ["unit"],
  })
  // Reference bounds apply to the numeric path only; reject a transposed range.
  .refine(
    (d) =>
      d.valueText !== undefined ||
      d.referenceLow === undefined ||
      d.referenceHigh === undefined ||
      d.referenceLow <= d.referenceHigh,
    {
      message: "referenceLow must not exceed referenceHigh",
      path: ["referenceLow"],
    },
  );

export type OcrCommitRow = z.infer<typeof ocrCommitRowSchema>;

export const ocrCommitSchema = z.object({
  rows: z.array(ocrCommitRowSchema).min(1).max(OCR_MAX_ROWS),
  /**
   * The vault document the client filed the scanned bytes into (kind
   * LAB_RESULT), so the committed labs can be cross-linked back to their source
   * (`inboundDocuments` module on). Optional: text-mode scans keep the image
   * on-device and file nothing, and a module-off account never files. Ownership
   * is verified server-side before any link is written.
   */
  documentId: z.string().trim().min(1).max(64).optional(),
  /**
   * The visit this panel came out of, when the review step offered one.
   *
   * Optional, always. A panel commits with no visit named and the commit
   * succeeds unchanged — the link is the by-the-way half of the flow, never
   * a condition of the write. Ownership is verified server-side, and one link
   * is written PER RESULT ROW rather than one for the panel: a re-run panel on
   * a different day links to its own visit, which is why the join is m:n and
   * not a scalar column on the result.
   */
  encounterId: z.string().trim().min(1).max(40).optional(),
});

export type OcrCommitInput = z.infer<typeof ocrCommitSchema>;

/**
 * A row the commit route did not write. `duplicate`: it matched a live reading
 * at commit time. `unit_mismatch`: it states a unit other than the one its
 * marker is tracked in. `unknown_biomarker`: the chosen `biomarkerId` is not
 * one of the record's markers.
 */
export interface OcrSkippedRowDto {
  analyte: string;
  reason: "duplicate" | "unit_mismatch" | "unknown_biomarker";
}

export interface OcrCommitResponseDto {
  inserted: unknown[];
  skipped: OcrSkippedRowDto[];
  /**
   * How the commit reads, resolved server-side from the two lists. The dialog
   * renders this rather than assuming a 200 means readings were saved — a
   * re-scan in which every confirmed row turned out to be a duplicate writes
   * nothing and must not report a green toast.
   */
  outcome: WrittenOutcome;
}

/** The capability-probe response (drives whether the UI shows the scan entry). */
export interface OcrCapabilityDto {
  available: boolean;
  /**
   * How the scan runs when available:
   *   - "vision": the provider reads the image directly (higher accuracy).
   *   - "text": the image is OCR'd in the browser (tesseract.js) and only the
   *     extracted text is sent to a text-only provider (less accurate; opt-in
   *     via `labsLocalOcrEnabled`). The UI loads the WASM only for this mode.
   *   - null: scanning is unavailable (see `reason`).
   */
  mode: "vision" | "text" | null;
  /** Why scanning is unavailable, when it is. */
  reason: "no-provider" | "enable-local-ocr" | null;
  /** Whether PDF uploads are accepted (Anthropic vision provider only). */
  pdfSupported: boolean;
  /**
   * The `labsOcr` capability for this record. When it is closed by anything
   * other than a missing provider or a missing consent receipt, `available`
   * is false with a null `reason`, and this says why.
   */
  ai: AiCapabilityState;
}

/**
 * The body of a TEXT-mode extract call. The browser OCR's the image and POSTs
 * the extracted text here (no image bytes ever reach the server). The route
 * forwards the text to the text-only provider for structuring, reusing the
 * exact review + commit flow the vision path uses.
 */
const OCR_TEXT_MAX_CHARS = 200_000;

export const ocrTextExtractSchema = z.object({
  mode: z.literal("text"),
  text: z.string().trim().min(1).max(OCR_TEXT_MAX_CHARS),
});

export type OcrTextExtractInput = z.infer<typeof ocrTextExtractSchema>;

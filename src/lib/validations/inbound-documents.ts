/**
 * v1.25 (W-DOCS-IN) — inbound clinical-document ingestion contract.
 *
 * A self-hoster uploads a doctor report / discharge letter they received. The
 * dedicated OCR/vision provider transcribes STRUCTURED FACTS that land on a
 * MANDATORY review-then-confirm screen; only the user-approved facts reach the
 * structured stores (labs / conditions / medications) through their normal
 * create paths.
 *
 * The safety line this module encodes: EXTRACT, NEVER INTERPRET. The provider
 * is asked to reproduce what is written (text, value, code, date) with
 * provenance and a confidence gate — it never infers a code, never flags a
 * value high/low, never links a condition to a medication, never assigns
 * meaning, severity, or a diagnosis. Diagnoses are stored as the document's
 * STATED assertion about the patient, never as the app's conclusion.
 *
 * This module holds:
 *   - `inboundExtractionSchema` — the schema the provider's JSON is validated
 *     against (UNTRUSTED model output). Liberal on shape; the review screen is
 *     the safety boundary.
 *   - the staged-fact DTO shapes the routes return + the UI consumes.
 *   - `inboundFactEditSchema` — the per-fact correction the review screen sends
 *     before approval (fixes OCR / units / dates / codes).
 *   - `inboundConfirmSchema` — the approve/reject decisions. No `userId` field;
 *     it is always narrowed from the session.
 */
import { z } from "zod/v4";

import type { AiCapabilityState } from "@/lib/ai/capabilities/types";

/** Max facts a single document may stage / confirm. A dense letter is ~40. */
export const INBOUND_MAX_FACTS = 120;

/**
 * Confidence floor. A fact scoring below this fails closed: it is staged with
 * `needsReview = true` and cannot be approved until the user edits it (the
 * values then become user-asserted). When unsure, the app surfaces raw text
 * for manual entry rather than guessing a value.
 */
export const INBOUND_CONFIDENCE_FLOOR = 0.6;

/** The three FHIR resources a fact maps to (stated status only). */
export const INBOUND_FACT_TYPES = [
  "CONDITION",
  "OBSERVATION",
  "MEDICATION_STATEMENT",
] as const;
export type InboundFactType = (typeof INBOUND_FACT_TYPES)[number];

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

/**
 * Narrow the free-String DB `source` column to the DTO union, or `null` for an
 * absent / unrecognised value. The column is a free String server-side (adding
 * a source needs no migration) so the read path guards it before it hits the
 * contract.
 */
export function toContentIndexSource(
  source: string | null | undefined,
): DocumentContentIndexSourceValue | null {
  return DOCUMENT_CONTENT_INDEX_SOURCES.includes(
    source as DocumentContentIndexSourceValue,
  )
    ? (source as DocumentContentIndexSourceValue)
    : null;
}

/**
 * What became of a document's plain-language summary. Mirrors the Prisma
 * `DocumentSummaryState` enum. The detail view branches on this rather than on
 * a null summary, which cannot tell "never attempted" from "in flight" from
 * "withheld" from "could not produce".
 */
export const DOCUMENT_SUMMARY_STATES = [
  "NONE",
  "PENDING",
  "READY",
  "WITHHELD",
  "UNAVAILABLE",
] as const;
export type DocumentSummaryStateValue =
  (typeof DOCUMENT_SUMMARY_STATES)[number];

/**
 * Refs #776 — why a document's most recent content-index attempt produced no
 * index. Mirrors the free-String `lastIndexOutcome` column (closed here, not
 * in the schema, so a new reason needs no migration); the detail view renders
 * a plain-words line per value instead of a bare "not indexed" that cannot
 * tell "never tried" from "tried and failed".
 */
export const DOCUMENT_INDEX_OUTCOMES = [
  "local-empty",
  "local-unsupported",
  "decrypt-error",
  "raster-failed",
  "provider-error",
  "pdf-needs-anthropic",
  "empty-transcription",
] as const;
export type DocumentIndexOutcomeValue =
  (typeof DOCUMENT_INDEX_OUTCOMES)[number];

/** Narrow the free-String DB column to the DTO union (null when unknown). */
export function toIndexOutcome(
  outcome: string | null | undefined,
): DocumentIndexOutcomeValue | null {
  return DOCUMENT_INDEX_OUTCOMES.includes(outcome as DocumentIndexOutcomeValue)
    ? (outcome as DocumentIndexOutcomeValue)
    : null;
}

/** The document lifecycle states. STORED is the library default. */
export const INBOUND_DOCUMENT_STATUSES = [
  "STORED",
  "EXTRACTING",
  "EXTRACTED",
  "FAILED",
  "CONFIRMED",
  "DISCARDED",
] as const;
export type InboundDocumentStatusValue =
  (typeof INBOUND_DOCUMENT_STATUSES)[number];

/**
 * The coding systems a fact's STATED code may belong to. The provider emits a
 * code ONLY when the document writes one — it never machine-guesses. Mirrors
 * the systems the existing FHIR mappers already speak (SNOMED/ICD-10 for a
 * Condition, LOINC for an Observation, RxNorm/ATC for a MedicationStatement).
 */
export const INBOUND_CODE_SYSTEMS = [
  "SNOMED",
  "ICD10",
  "LOINC",
  "RXNORM",
  "ATC",
] as const;
export type InboundCodeSystem = (typeof INBOUND_CODE_SYSTEMS)[number];

const confidenceScore = z.number().min(0).max(1).catch(0);
const nullableText = (max: number) =>
  z.string().trim().min(1).max(max).nullable().catch(null);

/**
 * One fact as the PROVIDER returns it (untrusted). A single flat shape across
 * the three fact types so the wire stays simple; the route maps it to the
 * per-type staged payload. Everything is `.catch`-guarded so a malformed field
 * degrades to null + low confidence rather than 422-ing the whole extraction.
 */
const extractedFactRawFields = z.object({
  type: z.enum(INBOUND_FACT_TYPES),
  /** Verbatim label / diagnosis text / medication name as written. */
  label: z.string().trim().min(1).max(300).catch(""),
  /** STATED code, present only when the document writes one. */
  code: nullableText(64),
  codeSystem: z.enum(INBOUND_CODE_SYSTEMS).nullable().catch(null),
  /** Condition: stated clinical / verification status (verbatim). */
  clinicalStatus: nullableText(64),
  verificationStatus: nullableText(64),
  /** Observation: numeric XOR qualitative value, unit, stated ref bounds. */
  value: z.number().finite().nullable().catch(null),
  valueText: nullableText(300),
  unit: nullableText(80),
  referenceLow: z.number().finite().nullable().catch(null),
  referenceHigh: z.number().finite().nullable().catch(null),
  /**
   * Observation: the reference range EXACTLY as printed, verbatim. A report
   * writes its window in prose ("3,5 - 5,0", "< 5", "bis 5,0", "negativ"), and
   * `referenceLow` / `referenceHigh` above can only carry the cases that
   * reduce to two numbers. This field is what stops every other case from
   * being dropped on the floor — the string is kept whether or not the parser
   * gets bounds out of it.
   */
  referenceText: nullableText(120),
  /** MedicationStatement: dose + stated status (verbatim). */
  dose: nullableText(120),
  medicationStatus: nullableText(64),
  /** A stated date for the fact (onset / effective / report), ISO or null. */
  effectiveDate: z.string().nullable().catch(null),
  /** Provenance: the verbatim source span this fact came from. */
  sourceText: z.string().trim().max(2000).catch(""),
  /** Optional 0-based page index the fact was read from. */
  page: z.number().int().min(0).max(10000).nullable().catch(null),
  /** The model's self-reported overall confidence for this fact (0..1). */
  confidence: confidenceScore.default(0),
});

/**
 * A window whose floor sits above its ceiling cannot be true, so it is dropped
 * rather than repaired. Swapping the pair would invent a range the report never
 * printed, and this schema cannot reject the fact the way `labs.ts` does —
 * every field above is `.catch()`ed precisely so one bad value does not sink a
 * whole extraction. `referenceText` survives either way, so nothing the
 * document actually stated is lost: the verbatim string is still there for a
 * person to read on the review screen.
 *
 * `parseReferenceRange` already answers a transposed PRINTED window this way.
 * These are the numbers the model reported instead, and they travelled
 * unchecked: an integration run against a real Postgres wrote a 100/30 pair
 * onto the row AND onto the freshly minted catalog marker, which then handed
 * the impossible window to every later reading of that analyte.
 */
export const extractedFactRawSchema = extractedFactRawFields.transform(
  (fact) => {
    if (
      fact.referenceLow !== null &&
      fact.referenceHigh !== null &&
      fact.referenceLow > fact.referenceHigh
    ) {
      return { ...fact, referenceLow: null, referenceHigh: null };
    }
    return fact;
  },
);

export type ExtractedFactRaw = z.infer<typeof extractedFactRawSchema>;

/** The full JSON envelope the provider returns. */
export const inboundExtractionSchema = z.object({
  reportDate: z.string().nullable().catch(null),
  kind: z.enum(INBOUND_DOCUMENT_KINDS).nullable().catch(null),
  facts: z.array(extractedFactRawSchema).max(INBOUND_MAX_FACTS).catch([]),
});

export type InboundExtraction = z.infer<typeof inboundExtractionSchema>;

// ─── Staged-fact payloads (FHIR-staged, stated status only) ────────────────

/** Per-field provenance carried on every staged fact. */
export interface FactProvenance {
  /**
   * The verbatim source span the value was transcribed from, read back out of
   * the extracted document text — NOT the model's echo of it. Empty string when
   * the span could not be located (see `anchored`).
   */
  sourceText: string;
  /**
   * True only when `sourceText` was resolved against the extracted document
   * text. False means the quote is unverifiable and none is stored: either the
   * model's echo matched nothing in the source, or the extraction ran in vision
   * mode, where there is no extracted text to verify against. A reviewer must
   * read an unanchored fact against the original document itself.
   */
  anchored: boolean;
  /** Character offset of the span in the extracted text; null when unanchored. */
  sourceOffset: number | null;
  /** Optional 0-based page index. */
  page: number | null;
  /** The model's self-reported confidence (0..1). */
  confidence: number;
}

/** Condition staging payload — maps to FHIR `Condition` (stated status). */
export interface ConditionFactData {
  label: string;
  code: string | null;
  codeSystem: InboundCodeSystem | null;
  clinicalStatus: string | null;
  verificationStatus: string | null;
  onsetDate: string | null;
}

/** Observation staging payload — maps to FHIR `Observation` (no range-flag). */
export interface ObservationFactData {
  label: string;
  code: string | null;
  codeSystem: InboundCodeSystem | null;
  value: number | null;
  valueText: string | null;
  unit: string | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  /**
   * The reference range as printed on the report, verbatim.
   *
   * Optional because it genuinely is: a fact staged before this field existed
   * carries no key for it, and that is an honest absence rather than a shim
   * for a caller we do not ship. Read it as `?? null`.
   */
  referenceText?: string | null;
  effectiveDate: string | null;
}

/** MedicationStatement staging payload — maps to FHIR `MedicationStatement`. */
export interface MedicationStatementFactData {
  name: string;
  dose: string | null;
  rxNormCode: string | null;
  atcCode: string | null;
  statusStated: string | null;
  effectiveDate: string | null;
}

export type FactData =
  ConditionFactData | ObservationFactData | MedicationStatementFactData;

/** The staged-fact DTO the routes return + the review UI consumes. */
export interface ExtractedFactDto {
  id: string;
  factType: InboundFactType;
  status: "PENDING" | "APPROVED" | "REJECTED";
  confidence: number;
  needsReview: boolean;
  data: FactData;
  provenance: FactProvenance;
  committedRecordId: string | null;
  committedRecordType: string | null;
}

/** One condition link on a document DTO (chip → `/illness/[id]`). */
export interface DocumentConditionLinkDto {
  episodeId: string;
  /** The episode's user-facing label. */
  name: string;
}

/**
 * One visit link on a document DTO — "this letter belongs to that appointment".
 *
 * Carries the visit's KIND as the enum constant rather than a rendered name.
 * A condition's label is the person's own words and reads the same in every
 * language; a visit kind is one of eight closed values whose human name the
 * reader's own bundle owns, so publishing the constant is what lets a German
 * reader and an English one each see it named correctly. The date and the id
 * are resolved server-side as usual.
 */
export interface DocumentEncounterLinkDto {
  encounterId: string;
  /** `ROUTINE` | `ACUTE` | … — the client renders the name. */
  kind: string;
  /** ISO-8601 instant of the visit. */
  occurredAt: string | null;
}

/**
 * One vaccination link on a document detail DTO — "this page records that
 * dose".
 *
 * `catalogSlug` is the catalogue entry when this release still knows the
 * dose's slug, so the reader's own bundle names it
 * (`vaccinations.catalog.<slug>`); `null` is the signal to show
 * `vaccineName`, the person's own wording. The same degrade the vaccination
 * DTO's `catalogEntry: null` carries.
 */
export interface DocumentVaccinationLinkDto {
  vaccinationId: string;
  /** ISO-8601 instant of the dose (UTC midnight — a Pass carries dates). */
  occurredAt: string | null;
  catalogSlug: string | null;
  vaccineName: string | null;
}

/** The document DTO (list + detail). */
export interface InboundDocumentDto {
  id: string;
  kind: InboundDocumentKindValue;
  /** User-given title (plaintext), or null when never set. */
  title: string | null;
  filename: string | null;
  mimeType: string;
  byteSize: number;
  status: InboundDocumentStatusValue;
  providerType: string | null;
  /** Model-transcribed report/collection date (YYYY-MM-DD), or null. */
  reportDate: string | null;
  /** User-set filing date (YYYY-MM-DD), or null. */
  documentDate: string | null;
  errorReason: string | null;
  /** Count of the document's non-REJECTED staged facts. */
  factCount: number;
  /** Count of staged facts still PENDING review. */
  pendingCount: number;
  /** Linked illness/condition episodes (empty when unlinked). */
  conditionLinks: DocumentConditionLinkDto[];
  /** Visits this document is filed against (empty when unlinked). */
  encounterLinks: DocumentEncounterLinkDto[];
  /** How the serve route delivers the original: render inline or download. */
  servingClass: "inline" | "attachment";
  /**
   * Whether the document has a content-search index (encrypted extracted text +
   * blind token array). `false` until the document is indexed (auto-indexed on
   * upload; the UI reads this for the searchable status, not as a to-do).
   */
  hasContentIndex: boolean;
  /**
   * How that index was produced — `vision` (an AI provider read the original)
   * vs a local extraction (`local-pdf` / `text-ocr` / `local-ocr`), or `null`
   * when `hasContentIndex` is false. Lets the UI tell an AI-read document from
   * a locally-indexed one and offer a richer "Read with AI" pass on the latter.
   */
  contentIndexSource: DocumentContentIndexSourceValue | null;
  /**
   * Refs #776 — when the most recent index attempt finished (ISO 8601),
   * successful or not. Null until any attempt ran (pre-existing rows, or a
   * document whose auto-index never fired).
   */
  lastIndexAttemptAt: string | null;
  /**
   * Refs #776 — why the most recent index attempt produced no index, or null
   * (attempt succeeded, or never ran — `lastIndexAttemptAt` tells the two
   * apart). The detail view renders the reason in plain words.
   */
  lastIndexOutcome: DocumentIndexOutcomeValue | null;
  /**
   * Whether the document has an encrypted preview thumbnail (rendered in the
   * background after upload). Gates the card's `<img>`: when false the card
   * shows its kind icon instead of fetching a thumbnail that 404s.
   */
  hasThumbnail: boolean;
  /**
   * v1.39.2 (#1038) — the system an imported document came from, or null for
   * one added in HealthLog. Paired with `sourceId`, its id over there.
   */
  sourceSystem: DocumentSourceSystemValue | null;
  sourceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InboundDocumentDetailDto extends InboundDocumentDto {
  facts: ExtractedFactDto[];
  /**
   * Doses this document is filed against, newest link last. `null` when the
   * caller acts inside somebody else's record under a grant that does not
   * cover the health background the doses live in: the page is shared, the
   * doses are not, and an empty list would claim the page records none.
   */
  vaccinationLinks: DocumentVaccinationLinkDto[] | null;
  /**
   * Short (3-4 sentence) plain-language summary of WHAT the document is,
   * generated once in the background after upload when the `documentsAutoAiRead`
   * opt-in is ON. Null when auto-read is OFF, no provider is configured, or the
   * background summary has not run yet. Descriptive only — never a diagnosis.
   */
  summary: string | null;
  /** When the background summary was generated (ISO 8601), or null. */
  summaryGeneratedAt: string | null;
  /**
   * What became of the summary. A null `summary` is ambiguous on its own —
   * never attempted, mid-flight, withheld by the safety screen and could-not-
   * produce all look identical — so the view reads this instead of guessing
   * "still generating".
   */
  summaryState: DocumentSummaryStateValue;
}

// ─── Edit (correction before approval) ─────────────────────────────────────

const reqText = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === "" ? null : v));
const optCode = z.enum(INBOUND_CODE_SYSTEMS).nullable().optional();
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "Expected a YYYY-MM-DD date")
  .nullable()
  .optional();

const conditionEditSchema = z.object({
  factType: z.literal("CONDITION"),
  label: reqText(300),
  code: optText(64),
  codeSystem: optCode,
  clinicalStatus: optText(64),
  verificationStatus: optText(64),
  onsetDate: isoDate,
});

const observationEditSchema = z
  .object({
    factType: z.literal("OBSERVATION"),
    label: reqText(300),
    code: optText(64),
    codeSystem: optCode,
    value: z.number().finite().nullable().optional(),
    valueText: optText(300),
    unit: optText(80),
    referenceLow: z.number().finite().nullable().optional(),
    referenceHigh: z.number().finite().nullable().optional(),
    referenceText: optText(120),
    effectiveDate: isoDate,
  })
  // Numeric XOR qualitative, mirroring the lab-result discipline. A null/absent
  // value with a null/absent valueText is allowed (the user may still be
  // entering it) but not BOTH set.
  .refine(
    (d) => !(typeof d.value === "number" && typeof d.valueText === "string"),
    {
      message: "Provide a numeric value OR qualitative text, not both",
      path: ["value"],
    },
  )
  // The same ordering rule the three lab schemas enforce. This is a person
  // typing on the review screen, not a model guessing, so it refuses rather
  // than dropping the pair silently — they can see the two numbers and fix
  // which one is which.
  .refine(
    (d) =>
      d.referenceLow === undefined ||
      d.referenceLow === null ||
      d.referenceHigh === undefined ||
      d.referenceHigh === null ||
      d.referenceLow <= d.referenceHigh,
    {
      message: "referenceLow must not exceed referenceHigh",
      path: ["referenceLow"],
    },
  );

const medicationEditSchema = z.object({
  factType: z.literal("MEDICATION_STATEMENT"),
  name: reqText(200),
  dose: optText(120),
  rxNormCode: optText(20),
  atcCode: optText(16),
  statusStated: optText(64),
  effectiveDate: isoDate,
});

/**
 * A correction to a staged fact (the review screen edits OCR / units / dates /
 * codes before approval). Discriminated by `factType` so the edit can never
 * change a fact's resource type. A successful edit clears `needsReview` — the
 * values become user-asserted.
 */
export const inboundFactEditSchema = z.discriminatedUnion("factType", [
  conditionEditSchema,
  observationEditSchema,
  medicationEditSchema,
]);

export type InboundFactEdit = z.infer<typeof inboundFactEditSchema>;

// ─── Confirm (approve / reject) ────────────────────────────────────────────

/**
 * The approve/reject decisions the user made on the review screen. Each
 * decision names a staged fact by id. Approved facts are committed to the
 * structured stores; rejected facts are discarded. No `userId` field — it is
 * always narrowed from the session; the route also re-scopes every fact id to
 * the document + the caller.
 */
export const inboundConfirmSchema = z.object({
  decisions: z
    .array(
      z.object({
        factId: z.string().trim().min(1).max(40),
        action: z.enum(["approve", "reject"]),
      }),
    )
    .min(1)
    .max(INBOUND_MAX_FACTS),
});

export type InboundConfirmInput = z.infer<typeof inboundConfirmSchema>;

/** The text-mode (local-OCR) extract body, mirroring the Lab-OCR text mode. */
export const INBOUND_TEXT_MAX_CHARS = 200_000;

export const inboundTextExtractSchema = z.object({
  mode: z.literal("text"),
  text: z.string().trim().min(1).max(INBOUND_TEXT_MAX_CHARS),
  kind: z.enum(INBOUND_DOCUMENT_KINDS).optional(),
});

export type InboundTextExtractInput = z.infer<typeof inboundTextExtractSchema>;

/**
 * The stored-text extract body: structure the document's OWN stored extracted
 * text (the content index the read/index step already produced) into staged
 * facts — no re-upload, no second read of the original. The document detail's
 * "Extract lab values" action posts this when an automatic staging run was
 * skipped or failed; the server refuses with `documents.inbound.notIndexed`
 * when there is no stored text to structure.
 */
export const inboundStoredExtractSchema = z.object({
  mode: z.literal("stored"),
});

export type InboundStoredExtractInput = z.infer<
  typeof inboundStoredExtractSchema
>;

// ─── Library: store / edit / list ──────────────────────────────────────────

/** A bare YYYY-MM-DD date string (no time component). */
const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "Expected a YYYY-MM-DD date");

export const DOCUMENT_TITLE_MAX = 200;

/** Max condition links a single document may carry / receive per request. */
export const DOCUMENT_MAX_EPISODE_LINKS = 20;

const episodeIdList = z
  .array(z.string().trim().min(1).max(40))
  .max(DOCUMENT_MAX_EPISODE_LINKS);

/**
 * Max visit links a single document may carry / receive per request.
 *
 * The same bound as the condition links, and for the same reason: a document
 * filed against twenty visits is a client defect rather than a large but
 * legitimate batch.
 */
export const DOCUMENT_MAX_ENCOUNTER_LINKS = 20;

const encounterIdList = z
  .array(z.string().trim().min(1).max(40))
  .max(DOCUMENT_MAX_ENCOUNTER_LINKS);

/**
 * Max vaccination links a single document may carry / receive per request.
 *
 * Higher than the visit and condition bounds on purpose. One childhood
 * record routinely covers every dose of a whole primary schedule, which is
 * well past twenty rows, and it is the normal case rather than an edge one.
 * The link service's own per-call ceiling is the bound.
 */
export const DOCUMENT_MAX_VACCINATION_LINKS = 100;

const vaccinationIdList = z
  .array(z.string().trim().min(1).max(40))
  .max(DOCUMENT_MAX_VACCINATION_LINKS);

/**
 * The store-only upload metadata (the multipart form fields beside the file).
 * Every field is optional — a bare file upload is valid and lands as a STORED
 * document with no title / category / filing date. `episodeIds` pre-links the
 * document to the caller's illness/condition episodes (repeated `episodeIds`
 * form fields; ownership is re-checked in the route), and `encounterIds` does
 * the same for the caller's visits — the review step offers the visit the
 * document's own date falls near, and the link rides the upload rather than
 * becoming a second trip. No `userId` field; it is always narrowed from the
 * session.
 */
/**
 * v1.39.2 (#1038) — the systems an imported document can say it came from.
 * Closed on purpose: the detail sheet names each one, and a free string here
 * would be a label the person never chose rendered as if HealthLog vouched for
 * it. OTHER covers any importer that is neither.
 */
export const DOCUMENT_SOURCE_SYSTEMS = ["PAPERLESS", "PAPRA", "OTHER"] as const;
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

/** Max length of an imported document's id in its source system. */
export const DOCUMENT_SOURCE_ID_MAX = 128;

export const documentCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(DOCUMENT_TITLE_MAX).optional(),
    kind: z.enum(INBOUND_DOCUMENT_KINDS).optional(),
    documentDate: isoDateString.optional(),
    episodeIds: episodeIdList.optional(),
    encounterIds: encounterIdList.optional(),
    /** Where an imported document came from (provenance, shown on detail). */
    sourceSystem: z.enum(DOCUMENT_SOURCE_SYSTEMS).optional(),
    /**
     * The document's id in `sourceSystem`. Printable ASCII only: it is a key,
     * not prose, and it is echoed on the detail sheet.
     */
    sourceId: z
      .string()
      .trim()
      .min(1)
      .max(DOCUMENT_SOURCE_ID_MAX)
      .regex(/^[\x21-\x7e]+$/u, "Expected printable characters without spaces")
      .optional(),
    /**
     * `defer` holds back automatic AI reading for this upload: the thumbnail
     * and a local text index still run, the summary and the lab staging do
     * not. Absent means today's behaviour.
     */
    aiRead: z.enum(["defer"]).optional(),
  })
  .refine((v) => v.sourceId === undefined || v.sourceSystem !== undefined, {
    path: ["sourceSystem"],
    message: "sourceId needs a sourceSystem",
  });

export type DocumentCreateInput = z.infer<typeof documentCreateSchema>;

/**
 * Metadata edit (rename / recategorise / set the filing date). At least one
 * field must be present. `title` accepts null to clear it; `documentDate`
 * accepts null to clear it. No `userId` field — narrowed from the session and
 * fed to the Prisma `where` alongside the row id.
 */
export const documentUpdateSchema = z
  .object({
    title: z
      .string()
      .trim()
      .max(DOCUMENT_TITLE_MAX)
      .nullable()
      .optional()
      .transform((v) => (v === "" ? null : v)),
    kind: z.enum(INBOUND_DOCUMENT_KINDS).optional(),
    documentDate: isoDateString.nullable().optional(),
    /**
     * Replace-set condition links: the document's links become exactly this
     * set (an empty array unlinks everything). Ownership of every episode id
     * is re-checked in the route against the caller's episodes.
     */
    episodeIds: episodeIdList.optional(),
    /** Replace-set visit links, same semantics as `episodeIds`. */
    encounterIds: encounterIdList.optional(),
    /**
     * Replace-set vaccination links, same semantics. The same table the
     * dose's own form writes from the other end.
     */
    vaccinationIds: vaccinationIdList.optional(),
  })
  .refine(
    (d) =>
      d.title !== undefined ||
      d.kind !== undefined ||
      d.documentDate !== undefined ||
      d.episodeIds !== undefined ||
      d.encounterIds !== undefined ||
      d.vaccinationIds !== undefined,
    { message: "Provide at least one field to update" },
  );

export type DocumentUpdateInput = z.infer<typeof documentUpdateSchema>;

/** Library list sort columns + page size. */
export const DOCUMENT_LIST_SORTS = [
  "documentDate",
  "createdAt",
  "title",
] as const;
export type DocumentListSort = (typeof DOCUMENT_LIST_SORTS)[number];

export const DOCUMENT_LIST_MAX_LIMIT = 100;
export const DOCUMENT_LIST_DEFAULT_LIMIT = 50;

/**
 * The library list query: title/filename search, category filter, a
 * `documentDate` range, sort + keyset pagination. Parsed off `searchParams`;
 * `safeParse` returns 422 on a bad value.
 */
export const documentListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  /**
   * Category filter — OR inside the facet. Repeated `kind` params or a
   * comma-separated value; the route normalises to an array before parsing.
   */
  kind: z.array(z.enum(INBOUND_DOCUMENT_KINDS)).max(16).optional(),
  /** Only documents linked to this illness/condition episode. */
  episodeId: z.string().trim().min(1).max(40).optional(),
  /** Only documents linked to this visit. */
  encounterId: z.string().trim().min(1).max(40).optional(),
  /** Only documents whose filing date falls in this calendar year (UTC). */
  year: z.coerce.number().int().min(1900).max(9999).optional(),
  from: isoDateString.optional(),
  to: isoDateString.optional(),
  sort: z.enum(DOCUMENT_LIST_SORTS).default("documentDate"),
  order: z.enum(["asc", "desc"]).default("desc"),
  cursor: z.string().trim().min(1).max(40).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(DOCUMENT_LIST_MAX_LIMIT)
    .default(DOCUMENT_LIST_DEFAULT_LIMIT),
});

export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;

// ─── Vault: bulk actions ───────────────────────────────────────────────────

/** Max document ids one bulk request may touch. */
export const DOCUMENT_BULK_MAX_IDS = 100;

export const DOCUMENT_BULK_ACTIONS = [
  "setKind",
  "linkEpisode",
  "unlinkEpisode",
  "linkEncounter",
  "unlinkEncounter",
  "delete",
  "restore",
] as const;
export type DocumentBulkAction = (typeof DOCUMENT_BULK_ACTIONS)[number];

/**
 * One bulk action over up to 100 owner-scoped documents. `setKind` requires
 * `kind`; `linkEpisode` / `unlinkEpisode` require `episodeId` (ownership
 * re-checked in the route). Per-id outcomes ride the response so a partial
 * failure never aborts the batch. No `userId` field — narrowed from the
 * session.
 */
export const documentBulkSchema = z
  .object({
    ids: z
      .array(z.string().trim().min(1).max(40))
      .min(1)
      .max(DOCUMENT_BULK_MAX_IDS),
    action: z.enum(DOCUMENT_BULK_ACTIONS),
    kind: z.enum(INBOUND_DOCUMENT_KINDS).optional(),
    episodeId: z.string().trim().min(1).max(40).optional(),
    encounterId: z.string().trim().min(1).max(40).optional(),
  })
  .refine((d) => d.action !== "setKind" || d.kind !== undefined, {
    message: "Action 'setKind' requires a kind",
    path: ["kind"],
  })
  .refine(
    (d) =>
      (d.action !== "linkEpisode" && d.action !== "unlinkEpisode") ||
      d.episodeId !== undefined,
    {
      message: "Episode actions require an episodeId",
      path: ["episodeId"],
    },
  )
  .refine(
    (d) =>
      (d.action !== "linkEncounter" && d.action !== "unlinkEncounter") ||
      d.encounterId !== undefined,
    {
      message: "Visit actions require an encounterId",
      path: ["encounterId"],
    },
  );

export type DocumentBulkInput = z.infer<typeof documentBulkSchema>;

/** Per-id outcome in the bulk response. */
export interface DocumentBulkResultDto {
  id: string;
  ok: boolean;
  /** Short machine reason when `ok` is false (e.g. "notFound", "conflict"). */
  error: string | null;
}

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
}

/** Where a document read egresses, vendor-blind. */
export type DocumentEgressClass = "local" | "external";

/**
 * The document-scoped AI capability probe response
 * (`GET /api/documents/inbound/capability`). Resolved over the DOCUMENT
 * provider order (local-first, codex last), so `mode` / `pdfSupported` /
 * `egress` match exactly what the document AI routes will do. `egress` drives
 * the vault's per-egress "this leaves your machine to a third-party AI" notice.
 */
export interface DocumentAiCapabilityDto {
  available: boolean;
  mode: "vision" | "text" | null;
  reason: "no-provider" | "enable-local-ocr" | null;
  pdfSupported: boolean;
  /**
   * Where a document read will egress with the current provider order:
   *   - "local":    stays on the operator's machine (self-hosted model).
   *   - "external": leaves the machine to a third-party AI service.
   *   - null:       no read is available (see `reason`).
   */
  egress: DocumentEgressClass | null;
  /**
   * The `documentAi` capability for this record. When it is closed by
   * anything other than a missing provider or a missing consent receipt,
   * `available` is false with a null `reason`, and this says why.
   */
  ai: AiCapabilityState;
}

// ─── AI assist / summary / index (Document vault P2) ────────────────────────

/**
 * The filing-metadata suggestion the assist endpoint returns. Drafts ONLY — the
 * client prefills the edit form and the user saves; nothing is written by the
 * suggest call. Every field is nullable (the model leaves it null when it
 * cannot read it confidently).
 */
export interface DocumentSuggestionDto {
  title: string | null;
  kind: InboundDocumentKindValue | null;
  documentDate: string | null;
}

/** The session-only summary/extracted-text mode the summary route serves. */
export const DOCUMENT_SUMMARY_MODES = ["summary", "text"] as const;
export type DocumentSummaryMode = (typeof DOCUMENT_SUMMARY_MODES)[number];

// ─── Chat about a document (Document vault P4) ──────────────────────────────

/** Max characters of a single user turn in a document chat. */
export const DOCUMENT_CHAT_MESSAGE_MAX = 4000;

/**
 * Request body for `POST /api/documents/inbound/{id}/chat`. No `userId` and no
 * `documentId` field — the user is narrowed from the session and the document id
 * comes from the path. `conversationId` continues an existing thread scoped to
 * this document; omitting it starts a new one. `locale` is the reply language
 * (the document chat, like the Coach, replies in de/en).
 */
export const documentChatRequestSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(64).optional(),
    message: z.string().trim().min(1).max(DOCUMENT_CHAT_MESSAGE_MAX),
    locale: z.enum(["en", "de"]).optional(),
  })
  .meta({ id: "DocumentChatRequest" });

export type DocumentChatRequestInput = z.infer<
  typeof documentChatRequestSchema
>;

/**
 * Query for `GET /api/documents/inbound/{id}/chat`. With `conversationId`, the
 * endpoint returns that one thread's messages (owner + document scoped); without
 * it, the paginated list of the document's chat threads for the sheet's rail.
 */
export const documentChatHistoryQuerySchema = z.object({
  conversationId: z.string().trim().min(1).max(64).optional(),
  cursor: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export type DocumentChatHistoryQuery = z.infer<
  typeof documentChatHistoryQuerySchema
>;

// ─── Fenced multi-document coach chat (S7) ──────────────────────────────────

/** Max documents attachable to one coach conversation. Bounds prompt size + the
 * numeric-grounding union; five labelled documents is already past the point a
 * chat answer stays useful. */
export const MAX_COACH_ATTACHMENTS = 5;

/**
 * Request body for `POST /api/insights/chat/fenced`. `.strict()` — the schema
 * REFUSES the tool-mode fields (`scope` / `guidedQuestion` / `prefill`) and
 * `userId` rather than silently dropping them, so a confused client fails loudly
 * in test. `conversationId` continues an existing FENCED thread; `attachmentIds`
 * (first-turn only, min 1) creates a fresh fenced thread — supplying BOTH is a
 * 422 (attach-to-existing goes through the attach endpoint; one write path per
 * concern). No `documentId` / `userId` field — the owner is narrowed from the
 * session, the documents come from the join table.
 */
export const fencedChatRequestSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(64).optional(),
    message: z.string().trim().min(1).max(DOCUMENT_CHAT_MESSAGE_MAX),
    locale: z.enum(["en", "de"]).optional(),
    attachmentIds: z
      .array(z.string().trim().min(1).max(64))
      .min(1)
      .max(MAX_COACH_ATTACHMENTS)
      .optional(),
  })
  .strict()
  .meta({ id: "FencedCoachChatRequest" });

export type FencedChatRequestInput = z.infer<typeof fencedChatRequestSchema>;

/**
 * Request body for `POST /api/insights/chat/{id}/attachments` — attach ONE
 * already-stored document to an existing conversation. `.strict()`; no `userId`.
 */
export const coachAttachmentCreateSchema = z
  .object({
    documentId: z.string().trim().min(1).max(64),
  })
  .strict()
  .meta({ id: "CoachAttachmentCreateRequest" });

export type CoachAttachmentCreateInput = z.infer<
  typeof coachAttachmentCreateSchema
>;

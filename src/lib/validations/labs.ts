/**
 * v1.17.1 — structured lab-result store.
 *
 * A minimal, generic `LabResult` capture path: a self-hoster records a
 * biomarker reading (HbA1c, LDL, ferritin, TSH, …) with its value, unit,
 * the lab's reference range, and the sample date. Pairs with the v1.17.1
 * Vorsorge annual-blood-panel reminder, which otherwise has nowhere to
 * record the result it reminds the user to obtain.
 *
 * The model is intentionally free-form on `analyte` + `unit` (no closed
 * LOINC enum): a lab report prints whatever name and unit it likes, and a
 * forced taxonomy would reject real-world values. The optional `panel`
 * groups analytes that arrived together (e.g. "Großes Blutbild").
 */
import { z } from "zod/v4";

import { LAB_UNIT_DESCRIPTION } from "@/lib/labs/dimensionless";
import { SOURCE_REFERENCE_TEXT_MAX } from "@/lib/labs/parse-reference-range";
import { validateEntryInstant } from "@/lib/validations/entry-instant";
import { isoDateTime } from "@/lib/validations/datetime";

/**
 * Far-past floor for a lab sample. A self-hoster legitimately backdates an
 * old paper report, so the window is generous (50 years) but still rejects
 * epoch-zero / corrupted-import instants via the shared 1900 floor.
 */
const LAB_TAKEN_AT_MAX_AGE_MS = 50 * 365.25 * 24 * 60 * 60 * 1000;

/** Shared `takenAt` field: ISO string → Date, plausibility-bounded. */
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

/** Trimmed, bounded free-text field with a min-length guard. */
const requiredText = (max: number) => z.string().trim().min(1).max(max);

const optionalPanel = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .optional()
  // An empty-string panel is normalised to "no panel" so the grouping
  // stays NULL-distinct rather than carrying a blank label.
  .or(z.literal("").transform(() => undefined));

const optionalNote = z
  .string()
  .trim()
  .max(2000)
  .optional()
  .or(z.literal("").transform(() => undefined));

/**
 * Reference bounds are independently optional (a lab may report only an
 * upper bound, e.g. LDL < 116). When BOTH are present the low bound must
 * not exceed the high bound — a transposed range is a client error.
 */
const referenceLow = z.number().finite().optional();
const referenceHigh = z.number().finite().optional();

/**
 * The reference range the SOURCE REPORT printed for this one reading.
 *
 * Distinct from `referenceLow` / `referenceHigh` above, which seed (and are
 * stamped from) the catalog marker's band. A lab runs its own method on its
 * own device, so the window a physician evaluates against is the one on that
 * report; these fields carry it, and `resolveEffectiveReferenceRange` lets it
 * win for that reading alone.
 *
 * `sourceReferenceText` is what was printed, verbatim. It is accepted with or
 * without derivable bounds: a window stated as "negativ" or "siehe Befund"
 * still belongs on the record, and dropping it because no number could be read
 * out of it is exactly the loss this field exists to stop.
 */
const sourceReferenceLow = z.number().finite().optional();
const sourceReferenceHigh = z.number().finite().optional();
const sourceReferenceText = z
  .string()
  .trim()
  .max(SOURCE_REFERENCE_TEXT_MAX)
  .optional()
  .or(z.literal("").transform(() => undefined));

/**
 * v1.18.1 — optional link to a user-scoped `Biomarker` (the catalog row).
 * When set, the structured-entry path resolves the unit + reference range
 * from the biomarker server-side, so `analyte` / `unit` may be omitted (the
 * route fills them from the catalog row). A free-text reading without a
 * catalog link stays valid (quick-capture / legacy path).
 */
const biomarkerId = z.string().trim().min(1).max(64).optional();

/**
 * v1.18.9 — a qualitative reading ("negativ" / "positiv" / "grenzwertig" /
 * "nicht nachweisbar"). Trimmed, non-empty, sensibly capped. Mutually
 * exclusive with the numeric `value` (see the create/update refinements).
 */
const valueText = requiredText(120).optional();

/**
 * v1.25 (iOS #36) — optional provenance marker. The on-device-OCR ingestion
 * path posts `source: "OCR"` so a reading captured from a phone-camera lab
 * photo records its provenance; the raw image never touches the server on this
 * path. Omitting the field reads as `"MANUAL"`, preserving the legacy
 * hand-entry contract exactly. Mirrors the `source: "OCR"` the server-side
 * `/api/labs/ocr/commit` path already stamps.
 */
const source = z.enum(["MANUAL", "OCR"]).optional();

export const createLabResultSchema = z
  .object({
    biomarkerId,
    panel: optionalPanel,
    analyte: requiredText(120).optional(),
    // v1.18.9 — `value` is no longer required: a reading is EITHER numeric
    // (`value`) OR qualitative (`valueText`), never both, never neither.
    value: z.number().finite().optional(),
    valueText,
    unit: requiredText(40).optional().describe(LAB_UNIT_DESCRIPTION),
    referenceLow,
    referenceHigh,
    sourceReferenceLow,
    sourceReferenceHigh,
    sourceReferenceText,
    takenAt: takenAtField,
    note: optionalNote,
    source,
    /**
     * The visit this reading came out of, when the form offered one. Optional
     * always: a reading saves with no visit named, and the link never gates
     * the write.
     */
    encounterId: z.string().trim().min(1).max(40).optional(),
  })
  // Either a catalog link OR a free-text analyte must be present.
  .refine((d) => d.biomarkerId !== undefined || d.analyte !== undefined, {
    message: "Either biomarkerId or analyte is required",
    path: ["analyte"],
  })
  // Numeric XOR qualitative: exactly one of `value` / `valueText` is set.
  .refine((d) => (d.value !== undefined) !== (d.valueText !== undefined), {
    message:
      "Provide exactly one of value (numeric) or valueText (qualitative)",
    path: ["value"],
  })
  // A numeric reading without a catalog link still needs a unit (the catalog
  // otherwise supplies it server-side). A qualitative reading needs no unit —
  // its result is the text, and a unit/range is meaningless for it.
  .refine(
    (d) =>
      d.valueText !== undefined ||
      d.biomarkerId !== undefined ||
      d.unit !== undefined,
    {
      message:
        "unit is required for a numeric reading when no biomarkerId is given",
      path: ["unit"],
    },
  )
  // Reference bounds apply to the numeric path only; skip them entirely for a
  // qualitative reading.
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
  )
  // Same guard on the source window. A transposed window is a client error
  // here for the same reason: nothing downstream can tell it from a real one.
  .refine(
    (d) =>
      d.valueText !== undefined ||
      d.sourceReferenceLow === undefined ||
      d.sourceReferenceHigh === undefined ||
      d.sourceReferenceLow <= d.sourceReferenceHigh,
    {
      message: "sourceReferenceLow must not exceed sourceReferenceHigh",
      path: ["sourceReferenceLow"],
    },
  );

export type CreateLabResultInput = z.infer<typeof createLabResultSchema>;

/**
 * Update schema: every field optional (partial edit). `panel` and `note`
 * accept an explicit `null` to clear the stored value — distinct from an
 * omitted key, which leaves the column untouched.
 */
export const updateLabResultSchema = z
  .object({
    panel: optionalPanel.or(z.null()),
    analyte: requiredText(120).optional(),
    value: z.number().finite().optional(),
    // v1.18.9 — edit the qualitative result. A row stays single-typed: a PUT
    // must not set BOTH `value` and `valueText` (the refine below). Switching a
    // row's type (numeric ↔ qualitative) is intentionally not supported here —
    // delete and re-add — so an omitted key leaves the row's existing type.
    valueText: requiredText(120).optional(),
    unit: requiredText(40).optional().describe(LAB_UNIT_DESCRIPTION),
    referenceLow: referenceLow.or(z.null()),
    referenceHigh: referenceHigh.or(z.null()),
    sourceReferenceLow: sourceReferenceLow.or(z.null()),
    sourceReferenceHigh: sourceReferenceHigh.or(z.null()),
    sourceReferenceText: sourceReferenceText.or(z.null()),
    takenAt: takenAtField.optional(),
    note: optionalNote.or(z.null()),
  })
  // A single edit never carries both a numeric and a qualitative value.
  .refine((d) => d.value === undefined || d.valueText === undefined, {
    message: "Provide value (numeric) or valueText (qualitative), not both",
    path: ["value"],
  })
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
  )
  .refine(
    (d) =>
      d.sourceReferenceLow === undefined ||
      d.sourceReferenceLow === null ||
      d.sourceReferenceHigh === undefined ||
      d.sourceReferenceHigh === null ||
      d.sourceReferenceLow <= d.sourceReferenceHigh,
    {
      message: "sourceReferenceLow must not exceed sourceReferenceHigh",
      path: ["sourceReferenceLow"],
    },
  );

export type UpdateLabResultInput = z.infer<typeof updateLabResultSchema>;

/**
 * Inverted-range merge guard for a PARTIAL bound update.
 *
 * The schema-level `referenceLow <= referenceHigh` refine only fires when both
 * bounds arrive in the SAME request. A partial PUT that moves a single bound
 * past the row's existing other bound slips through the schema. The route
 * resolves the EFFECTIVE bounds (the parsed value when present, else the
 * stored value) and calls this to reject a transposed window with a 422.
 *
 * Returns true when both effective bounds are concrete numbers and low > high.
 */
export function isInvertedRange(
  effectiveLow: number | null,
  effectiveHigh: number | null,
): boolean {
  return (
    effectiveLow !== null &&
    effectiveHigh !== null &&
    effectiveLow > effectiveHigh
  );
}

/** Resolve an effective bound: the parsed value when present, else the stored. */
export function effectiveBound(
  parsed: number | null | undefined,
  stored: number | null,
): number | null {
  return parsed !== undefined ? parsed : stored;
}

/** List query: filter by biomarker / analyte (exact) + date range, paginate. */
export const listLabResultsSchema = z.object({
  // v1.18.1 — filter to one catalog marker's readings (the detail chart feed).
  biomarkerId: z.string().trim().min(1).max(64).optional(),
  analyte: z.string().trim().min(1).max(120).optional(),
  panel: z.string().trim().min(1).max(120).optional(),
  /**
   * Case-insensitive substring over the analyte and the panel name, so a
   * picker can find one result in a long history without paging to it.
   */
  q: z.string().trim().min(1).max(120).optional(),
  from: isoDateTime({ offset: false })
    .transform((s) => new Date(s))
    .optional(),
  to: isoDateTime({ offset: false })
    .transform((s) => new Date(s))
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

export type ListLabResultsInput = z.infer<typeof listLabResultsSchema>;

/**
 * The per-marker overview takes no parameters: it always covers the whole
 * live history. Strict, so a stray `limit` is refused rather than silently
 * ignored by a caller expecting it to cap something.
 */
export const labOverviewQuerySchema = z.object({}).strict();

/**
 * Reference-range classification lives in `@/lib/labs/reference-range` so the
 * API response, the doctor-report PDF, and the lab list card all share one
 * implementation. Re-exported here for the existing import sites.
 */
export {
  classifyReferenceRange,
  type EffectiveReferenceRange,
  type ReferenceRangeOrigin,
  type ReferenceRangeStatus,
  type SourceReferenceRange,
} from "@/lib/labs/reference-range";

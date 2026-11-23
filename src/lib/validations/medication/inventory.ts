import { z } from "zod/v4";
import { isoDateTime } from "@/lib/validations/datetime";

/**
 * v1.4.25 — inventory (pen / vial) CRUD validators.
 *
 * The Prisma model carries a 4-state enum
 * (ACTIVE | IN_USE | EXPIRED | USED_UP); the API surface only lets
 * the user explicitly transition into IN_USE (mark-as-first-use) or
 * USED_UP (manual override). EXPIRED is owned by the daily cron and
 * the intake hook, so the PATCH schema deliberately omits it.
 */
/**
 * v1.16.10 — container kinds, mirrored from the Prisma
 * `MedicationContainerType` enum. Beyond labelling the row, the kind
 * decides whether opening the container starts a post-opening clock —
 * see `IN_USE_CLOCK_CONTAINER_TYPES` in
 * `src/lib/medications/inventory/state-machine.ts`.
 */
export const MEDICATION_CONTAINER_TYPE_VALUES = [
  "PEN",
  "AMPOULE",
  "BLISTER",
  "INHALER",
  "BOTTLE",
  "OTHER",
] as const;
export type MedicationContainerTypeValue =
  (typeof MEDICATION_CONTAINER_TYPE_VALUES)[number];

export const createInventoryItemSchema = z
  .object({
    /** Units the container ships with. v1.16.10 raises the cap from
     *  100 to 1000 (large tablet packs) and renames the wire field to
     *  `unitsTotal` — it counts units, mapped to doses via
     *  `Medication.unitsPerDose`. */
    unitsTotal: z
      .number()
      .min(1)
      .max(1000)
      .describe(
        "Units the container ships with (tablets / ampoules / puffs; 1–1000, fractional allowed for split-pill packs). Dose-derived readouts divide by the medication's `unitsPerDose`.",
      ),
    /** v1.16.10 — container kind. Defaults to OTHER when absent. */
    containerType: z
      .enum(MEDICATION_CONTAINER_TYPE_VALUES)
      .optional()
      .describe(
        "Kind of physical container (PEN / AMPOULE / BLISTER / INHALER / BOTTLE / OTHER). Defaults to OTHER. PEN and AMPOULE are the sealed reservoirs the first dose breaches, so they carry a 30-day post-opening window; every other kind expires only on its printed date.",
      ),
    printedExpiry: isoDateTime()
      .transform((s) => new Date(s))
      .nullable()
      .optional(),
    purchasedAt: isoDateTime()
      .transform((s) => new Date(s))
      .nullable()
      .optional(),
    /** Carton labelling — free text, see the schema comment on the model
     *  for why neither is parsed into a structured value. */
    manufacturer: z
      .string()
      .max(120)
      .nullable()
      .optional()
      .describe(
        "Marketing-authorisation holder / maker as printed on the carton. Free text, max 120 chars.",
      ),
    doseStrength: z
      .string()
      .max(60)
      .nullable()
      .optional()
      .describe(
        'Strength as printed on the container, e.g. "5 mg/0.5 ml". Free text, max 60 chars — deliberately not split into a number + unit because pens state strength per dose, per ml, or per cartridge.',
      ),
    notes: z.string().max(200).nullable().optional(),
  })
  .meta({
    id: "CreateMedicationInventoryItemRequest",
    description:
      "Register a new supply container (pen / blister pack / bottle). `unitsTotal` counts UNITS (1–1000); the item starts ACTIVE with `unitsRemaining = unitsTotal` and the intake consumption hook decrements it per taken dose.",
  });

export const updateInventoryItemSchema = z
  .object({
    markAsFirstUseAt: isoDateTime()
      .transform((s) => new Date(s))
      .nullable()
      .optional()
      .describe(
        "Opening date of the container (the user opened it without logging an intake). ACTIVE flips to IN_USE. `null` clears it — the container reads as unopened again, which is how a wrongly auto-opened row is corrected. For a PEN or an AMPOULE this also starts / stops the 30-day in-use clock; other container kinds carry no such clock and expire only on their printed date.",
      ),
    markAsUsedUp: z
      .boolean()
      .optional()
      .describe(
        "Terminal override: zero the remaining units and mark the container USED_UP (physically discarded).",
      ),
    printedExpiry: isoDateTime()
      .transform((s) => new Date(s))
      .nullable()
      .optional(),
    /**
     * v1.16.1 — stock correction (the Bestand tab's adjust / withdraw
     * flow). Sets the remaining-unit count directly; the route clamps to
     * `unitsTotal` and re-runs the canonical state machine (0 ⇒ USED_UP,
     * a raise out of 0 re-evaluates against the expiry clocks).
     * v1.16.10 raises the cap to 1000 alongside the capacity cap and
     * renames the wire field to `unitsRemaining` (it always counted
     * units), matching the response side.
     */
    unitsRemaining: z
      .number()
      .min(0)
      .max(1000)
      .optional()
      .describe(
        "Absolute remaining-unit correction (0–1000, fractional allowed). Clamped server-side to the item's `unitsTotal`; the canonical state machine re-derives the state (0 ⇒ USED_UP).",
      ),
    /** Carton labelling — free text, see the schema comment on the model
     *  for why neither is parsed into a structured value. */
    manufacturer: z
      .string()
      .max(120)
      .nullable()
      .optional()
      .describe(
        "Marketing-authorisation holder / maker as printed on the carton. Free text, max 120 chars.",
      ),
    doseStrength: z
      .string()
      .max(60)
      .nullable()
      .optional()
      .describe(
        'Strength as printed on the container, e.g. "5 mg/0.5 ml". Free text, max 60 chars — deliberately not split into a number + unit because pens state strength per dose, per ml, or per cartridge.',
      ),
    notes: z.string().max(200).nullable().optional(),
  })
  .meta({
    id: "UpdateMedicationInventoryItemRequest",
    description:
      "Per-item inventory mutation: manual first-use, used-up override, printed-expiry correction, absolute remaining-unit correction, notes. Every field is optional and commutative.",
  });

export type CreateInventoryItemInput = z.infer<
  typeof createInventoryItemSchema
>;
export type UpdateInventoryItemInput = z.infer<
  typeof updateInventoryItemSchema
>;

/**
 * v1.4.25 — `POST /api/medications/[id]/glp1` body validators.
 *
 * The convenience route accepts either a `doseChange` or an `inventory`
 * payload (the route picks one). Both branches were hand-rolled
 * `typeof === "number"` checks pre-Fix-K, which let `NaN`, `Infinity`,
 * negative doses, and unbounded notes slip through.
 *
 * Bounds:
 * - `doseValue` is finite, non-negative, capped at 100 mg (covers every
 *   real-world GLP-1 step with headroom).
 * - `doseUnit` is a short string (mg / mcg / IE).
 * - `note` is capped at 500 characters so the field can't be used as a
 *   blob smuggler.
 * - `effectiveFrom` is constrained to a ±5-year window around now —
 *   a paper-record back-fill or a planned future step both fit, but
 *   "1970" / "9999" do not.
 * - `delta` is a non-zero finite integer in [−100, 100] — the legacy
 *   ledger counts pens, and ±100 pens per correction stays plenty
 *   (deliberately NOT raised with the v1.16.10 per-item unit cap).
 * - `reason` is a bounded string (the route logs it; raw blob bad).
 */
const MAX_DOSE_MG = 100;
const MAX_NOTE_CHARS = 500;
const MAX_REASON_CHARS = 200;
const MIN_EFFECTIVE_FROM = new Date("2020-01-01T00:00:00Z");
const FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1000;

const effectiveFromSchema = isoDateTime()
  .transform((s) => new Date(s))
  .refine((d) => d.getTime() >= MIN_EFFECTIVE_FROM.getTime(), {
    message: "effectiveFrom must be on or after 2020-01-01",
  })
  .refine((d) => d.getTime() <= Date.now() + FIVE_YEARS_MS, {
    message: "effectiveFrom must be within 5 years of now",
  });
const doseValueSchema = z.number().finite().min(0).max(MAX_DOSE_MG);
const doseUnitSchema = z.string().min(1).max(10);
const doseNoteSchema = z.string().max(MAX_NOTE_CHARS).nullable();

/** #169 — the client's own id for a titration step. */
const glp1DoseChangeClientIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

/**
 * Removing a titration step by the client's own id
 * (`DELETE /api/medications/[id]/glp1/dose-changes?clientId=`), for a step a
 * device removed before its upload answered.
 */
export const glp1DoseChangeDeleteQuerySchema = z.object({
  clientId: glp1DoseChangeClientIdSchema.describe(
    "The client id the step was (or may have been) uploaded under.",
  ),
});

export const glp1DoseChangePostSchema = z.object({
  effectiveFrom: effectiveFromSchema,
  doseValue: doseValueSchema,
  doseUnit: doseUnitSchema,
  note: doseNoteSchema.optional(),
  /**
   * #169 — the client's own id for the step. Unique per medication: a second
   * POST with the same id answers the stored row (200) instead of creating
   * one, so a step two devices hold locally is uploaded once. Never edited.
   */
  clientId: glp1DoseChangeClientIdSchema
    .optional()
    .describe(
      "Optional client-side id of the step, 1–128 characters of `A–Z a–z 0–9 . _ : -`. Unique per medication: a second create with the same id returns the stored step with 200 and changes nothing, whatever else the body says. Fixed at create; a correction cannot change it.",
    ),
});

/**
 * #169 — correcting a titration step. Every field optional, at least one
 * present; `note: null` clears the note. The client id is not in the shape
 * (strict), because it names the step rather than describing it.
 */
export const glp1DoseChangePatchSchema = z
  .object({
    effectiveFrom: effectiveFromSchema.optional(),
    doseValue: doseValueSchema.optional(),
    doseUnit: doseUnitSchema.optional(),
    note: doseNoteSchema.optional(),
  })
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    message: "Name at least one of effectiveFrom, doseValue, doseUnit, note",
  })
  .meta({
    id: "Glp1DoseChangePatchRequest",
    description:
      "Correct one titration step. Every field is optional and at least one is required; a field left out keeps its value, `note: null` clears the note. The client id cannot be changed.",
  });

/**
 * DEPRECATED write path (v1.16.10) — the `inventory.delta` branch feeds
 * the legacy `MedicationInventoryEvent` running-sum ledger. The per-item
 * endpoints (`POST /api/medications/[id]/inventory`,
 * `PATCH /api/medications/[id]/inventory/[itemId]`) replaced it; reads
 * fall back to the ledger only while a medication has zero inventory
 * items. New callers must register containers instead of posting deltas.
 */
export const glp1InventoryPostSchema = z.object({
  delta: z
    .number()
    .int()
    .finite()
    .min(-100)
    .max(100)
    .refine((n) => n !== 0, { message: "delta must be non-zero" })
    .describe(
      "Deprecated since v1.16.10: pen-count delta on the legacy running-sum ledger. Register containers via the inventory endpoints instead; reads use the ledger only while the medication has no inventory items.",
    ),
  reason: z.string().min(1).max(MAX_REASON_CHARS),
});

export const glp1PostBodySchema = z
  .object({
    doseChange: glp1DoseChangePostSchema.optional(),
    inventory: glp1InventoryPostSchema.optional(),
  })
  .refine((b) => Boolean(b.doseChange) !== Boolean(b.inventory), {
    message: "Body must carry exactly one of doseChange or inventory",
  });

export type Glp1DoseChangePostInput = z.infer<typeof glp1DoseChangePostSchema>;
export type Glp1DoseChangePatchInput = z.infer<
  typeof glp1DoseChangePatchSchema
>;
export type Glp1InventoryPostInput = z.infer<typeof glp1InventoryPostSchema>;
export type Glp1PostBodyInput = z.infer<typeof glp1PostBodySchema>;

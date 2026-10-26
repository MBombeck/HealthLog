/**
 * v1.25 — request/response validation for the opt-in mental-health screeners
 * (PHQ-9 / GAD-7; v1.27.9 adds WHO-5 + SCI). The item answers are small
 * integers whose ceiling is instrument-specific (PHQ/GAD 0–3, SCI 0–4,
 * WHO-5 0–5); the array length must match the instrument. `userId` is NEVER
 * a body field — it is narrowed from the session in the handler (CLAUDE.md
 * convention).
 */
import { z } from "zod/v4";
import {
  INSTRUMENTS,
  type InstrumentId,
} from "@/lib/mental-health/instruments";
import { assertStableExternalId } from "@/lib/validations/external-id";
import { isValidTimezone } from "@/lib/tz/format";
import { isoDateTime } from "@/lib/validations/datetime";

export const assessmentInstrumentEnum = z.enum(["PHQ9", "GAD7", "WHO5", "SCI"]);

/**
 * The mental-health screeners, as opposed to every `AssessmentInstrument`.
 * Since v1.43 the table also stores AUDIT-C (the alcohol section of the life
 * circumstances), which no mental-health surface may list or score: older app
 * builds decode `instrument` against exactly these four values.
 */
export const SCREENER_INSTRUMENTS = assessmentInstrumentEnum.options;
export type ScreenerInstrument = (typeof SCREENER_INSTRUMENTS)[number];

export function isScreenerInstrument(
  instrument: string,
): instrument is ScreenerInstrument {
  return (SCREENER_INSTRUMENTS as readonly string[]).includes(instrument);
}

/**
 * Client provenance for an administration. Closed enum so the column can never
 * carry a free-form label. `WEB` is the in-app questionnaire (the DB default);
 * `IOS` is the native client. Distinct from `MeasurementSource` on purpose — a
 * screener is questionnaire input, not a device sample, so it keeps its own
 * narrow vocabulary.
 */
export const assessmentSourceEnum = z.enum(["WEB", "IOS"]);

// Structural ceiling — the WHO-5's 0–5 scale is the widest. The exact
// per-instrument ceiling (PHQ/GAD 3, SCI 4) is enforced in the superRefine
// below, where the instrument is known.
const itemAnswer = z.number().int().min(0).max(5);

export const createAssessmentSchema = z
  .object({
    instrument: assessmentInstrumentEnum,
    /** Per-item answers, ordered as the instrument presents them. */
    items: z.array(itemAnswer).min(1).max(12),
    /** Optional functional-impairment follow-up (not scored into the total). */
    functionalDifficulty: z.number().int().min(0).max(3).optional(),
    /** ISO instant the screener was taken; defaults to now server-side. */
    takenAt: isoDateTime({ offset: false }).optional(),
    tz: z
      .string()
      .max(64)
      .refine(isValidTimezone, "Invalid IANA timezone")
      .optional(),
    /**
     * The reader's app language: it selects the questionnaire text that was
     * shown and the crisis resources. Defaults to the account's language.
     */
    locale: z.string().max(16).optional(),
    /**
     * The reader switched to the English original instead of their
     * language's text. The server records which wording the answers were
     * given in from this and `locale`.
     */
    englishOriginal: z.boolean().optional(),
    /** Client provenance; defaults to WEB. */
    source: assessmentSourceEnum.optional().default("WEB"),
    /**
     * Optional client-supplied idempotency anchor. When present, a repeat with
     * the same value returns the existing administration instead of minting a
     * duplicate — durable replay protection beyond the 24h idempotency-key
     * window (the native client's outbox). Bounded to the 120-char measurement
     * externalId cap.
     */
    externalId: z.string().min(1).max(120).optional(),
  })
  .superRefine((val, ctx) => {
    const def = INSTRUMENTS[val.instrument as InstrumentId];
    if (val.items.length !== def.itemCount) {
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: `${val.instrument} expects exactly ${def.itemCount} item answers`,
      });
    }
    val.items.forEach((answer, index) => {
      if (answer > def.itemMax) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index],
          message: `${val.instrument} answers range 0–${def.itemMax}`,
        });
      }
    });
  })
  // The replay anchor only protects against a duplicate administration
  // while the id is stable across client launches.
  .superRefine(assertStableExternalId);

export const listAssessmentsSchema = z.object({
  instrument: assessmentInstrumentEnum.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export type CreateAssessmentInput = z.infer<typeof createAssessmentSchema>;

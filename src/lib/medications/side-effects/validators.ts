/**
 * v1.4.25 W19d — Zod validators for the side-effect API surface.
 *
 * The category supplied on the wire is sanity-checked against the
 * authoritative entry → category mapping in `./taxonomy.ts`; on
 * mismatch the route returns 422. This means a client cannot
 * accidentally (or maliciously) write a NAUSEA row stamped with the
 * INJECTION_SITE category and confuse the Coach aggregator.
 *
 * Severity is bounded 1-5 — the same range as the DB-level CHECK
 * constraint and the `SideEffectSeverity` type-guard. Notes are
 * capped to 280 chars (the chat-bubble length budget the timeline
 * renders inside).
 */

import { z } from "zod/v4";

export const SIDE_EFFECT_CATEGORY_VALUES = [
  "GI",
  "METABOLIC",
  "INJECTION_SITE",
  "COGNITIVE",
  "GLP1_SPECIFIC",
] as const;

export const SIDE_EFFECT_ENTRY_VALUES = [
  "NAUSEA",
  "VOMITING",
  "DIARRHEA",
  "CONSTIPATION",
  "ABDOMINAL_PAIN",
  "HYPOGLYCEMIA_SYMPTOMS",
  "DEHYDRATION",
  "ANOREXIA",
  "ELECTROLYTE_FATIGUE",
  "INJECTION_REDNESS",
  "INJECTION_SWELLING",
  "INJECTION_BRUISING",
  "INJECTION_INDURATION",
  "BRAIN_FOG",
  "DIZZINESS",
  "LOW_MOOD",
  "LOW_ENERGY",
  "EARLY_SATIETY",
  "GASTROPARESIS_LIKE",
  "DYSGEUSIA",
  "GALLBLADDER_DISCOMFORT",
] as const;

export const SIDE_EFFECT_NOTES_MAX = 280;

export const createSideEffectSchema = z.object({
  category: z.enum(SIDE_EFFECT_CATEGORY_VALUES),
  entry: z.enum(SIDE_EFFECT_ENTRY_VALUES),
  severity: z.number().int().min(1).max(5),
  occurredAt: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  notes: z.string().max(SIDE_EFFECT_NOTES_MAX).nullable().optional(),
});

export const listSideEffectsSchema = z.object({
  from: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  to: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export type CreateSideEffectInput = z.infer<typeof createSideEffectSchema>;
export type ListSideEffectsInput = z.infer<typeof listSideEffectsSchema>;

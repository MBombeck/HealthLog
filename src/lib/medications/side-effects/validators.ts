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

import {
  MedicationSideEffectCategory,
  MedicationSideEffectEntry,
} from "@/generated/prisma/client";

/**
 * v1.4.25 W21 Fix-N (simp-M1) — these arrays used to restate the
 * Prisma enum keys verbatim, which meant adding a new entry required
 * three separate edits (schema, taxonomy map, validator array) that
 * could silently drift. The arrays are now derived from the Prisma
 * enum constant at module load. The drift-guard test
 * (`__tests__/drift-guard.test.ts`) asserts the three sources (Prisma
 * enum, taxonomy map, validator arrays) cover the same keys.
 *
 * Zod accepts the `nativeEnum` shape from the Prisma client const so
 * the schema stays expressed in the same TypeScript-narrowable form.
 */
export const SIDE_EFFECT_CATEGORY_VALUES = Object.values(
  MedicationSideEffectCategory,
) as readonly MedicationSideEffectCategory[];

export const SIDE_EFFECT_ENTRY_VALUES = Object.values(
  MedicationSideEffectEntry,
) as readonly MedicationSideEffectEntry[];

const SIDE_EFFECT_NOTES_MAX = 280;

/**
 * v1.4.25 W21 Fix-N (code-M6) — `category` was dropped from the wire
 * schema. The route now derives the canonical category from `entry`
 * via `categoryForEntry`. Older clients that still send `category` see
 * it silently ignored (Zod strips unknown fields by default), and the
 * row lands with the correct mapping regardless. No iOS DTO consumes
 * the old shape, so this is backwards-compatible without a versioned
 * envelope.
 */
export const createSideEffectSchema = z.object({
  entry: z.nativeEnum(MedicationSideEffectEntry),
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

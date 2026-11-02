/**
 * v1.18.1 — user-scoped Biomarker catalog validation.
 *
 * A `Biomarker` defines a lab marker ONCE: canonical name, unit, reference
 * bounds, and an optional context note. Recording a value later is just
 * picking the biomarker — the unit and reference range are resolved
 * server-side from the catalog row, never re-entered (ending the per-row
 * free-text divergence: "LDL" vs "ldl", `mg/dL` vs `mg/dl`).
 *
 * The reference window is the lab/sex/age-dependent "normal" range; the
 * server's neutral range verdict (`classifyReferenceRange`) is computed
 * against these bounds. Both are independently optional (a marker may report
 * only an upper bound, e.g. LDL < 116); when both are present the lower must
 * not exceed the upper.
 */
import { z } from "zod/v4";

import { LAB_UNIT_DESCRIPTION } from "@/lib/labs/dimensionless";

const requiredText = (max: number) => z.string().trim().min(1).max(max);

const lowerBound = z.number().finite().optional();
const upperBound = z.number().finite().optional();

const optionalContext = z
  .string()
  .trim()
  .max(2000)
  .optional()
  // An empty / whitespace-only context normalises to "no context" so a
  // blank field clears rather than stores an empty string.
  .transform((v) => (v && v.length > 0 ? v : undefined));

const optionalPanel = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .optional()
  .or(z.literal("").transform(() => undefined));

export const createBiomarkerSchema = z
  .object({
    name: requiredText(120),
    unit: requiredText(40).describe(LAB_UNIT_DESCRIPTION),
    lowerBound,
    upperBound,
    context: optionalContext,
    panel: optionalPanel,
  })
  .refine(
    (d) =>
      d.lowerBound === undefined ||
      d.upperBound === undefined ||
      d.lowerBound <= d.upperBound,
    {
      message: "lowerBound must not exceed upperBound",
      path: ["lowerBound"],
    },
  );

export type CreateBiomarkerInput = z.infer<typeof createBiomarkerSchema>;

/**
 * Update schema: every field optional (partial edit). `context` / `panel` /
 * a bound accept an explicit `null` to clear the stored value — distinct from
 * an omitted key, which leaves the column untouched.
 */
export const updateBiomarkerSchema = z
  .object({
    name: requiredText(120).optional(),
    unit: requiredText(40).optional().describe(LAB_UNIT_DESCRIPTION),
    lowerBound: lowerBound.or(z.null()),
    upperBound: upperBound.or(z.null()),
    context: optionalContext.or(z.null()),
    panel: optionalPanel.or(z.null()),
    // v1.22 — hide / unhide a marker. An omitted key leaves visibility
    // untouched; `true` drops the marker from the active list + pickers.
    hidden: z.boolean().optional(),
    // v1.43 — the other spellings this marker answers to, as a whole
    // set: what is listed stays or is added, what is not is removed. Omitted
    // leaves them untouched, so an older client's PUT keeps them.
    aliases: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  })
  .refine(
    (d) =>
      d.lowerBound === undefined ||
      d.lowerBound === null ||
      d.upperBound === undefined ||
      d.upperBound === null ||
      d.lowerBound <= d.upperBound,
    {
      message: "lowerBound must not exceed upperBound",
      path: ["lowerBound"],
    },
  );

export type UpdateBiomarkerInput = z.infer<typeof updateBiomarkerSchema>;

/**
 * Daily nutrient targets a person sets for themselves (#1402).
 *
 * Stored in `User.nutrientTargetsJson`, keyed by catalog code. Each target is
 * an amount in the code's canonical unit and a direction: `target` is an
 * amount to reach (protein), `limit` one to stay under (sugar, sodium). Every
 * code is optional and `null` clears it; an account that never set one stores
 * nothing. The charts prefer the person's own number over the dietary
 * reference; nothing here judges whether a target is sensible beyond the
 * code's plausibility cap, which only stops a unit slip.
 */
import { z } from "zod/v4";

import {
  NUTRIENT_CATALOG,
  NUTRIENT_CODES,
  type NutrientCode,
} from "@/lib/nutrients/catalog";

export interface NutrientTarget {
  value: number;
  direction: "target" | "limit";
}

/** The resolved targets: only the codes that carry one. */
export type NutrientTargets = Partial<Record<NutrientCode, NutrientTarget>>;

function targetSchema(code: NutrientCode) {
  return z
    .object({
      value: z
        .number()
        .finite()
        .positive()
        .max(NUTRIENT_CATALOG[code].plausibleDailyMax),
      direction: z.enum(["target", "limit"]),
    })
    .strict();
}

const targetShape = Object.fromEntries(
  NUTRIENT_CODES.map((code) => [
    code,
    targetSchema(code).nullable().optional(),
  ]),
) as Record<
  NutrientCode,
  z.ZodOptional<z.ZodNullable<ReturnType<typeof targetSchema>>>
>;

/**
 * The PATCH body: `targets` names the codes to change, each a target or
 * `null` to clear it. An unknown code is refused.
 */
export const nutrientTargetsPatchSchema = z
  .object({
    targets: z
      .object(targetShape)
      .strict()
      .describe(
        "The codes to change, each `{ value, direction }` in the code's canonical unit (see the catalogue) or `null` to clear it. Codes left out stay as they were. `value` is above 0 and at most the code's plausibility cap.",
      ),
  })
  .strict()
  .meta({
    id: "NutrientTargetsPatchRequest",
    description: "Set or clear daily nutrient targets, code by code.",
  });

export type NutrientTargetsPatch = z.infer<typeof nutrientTargetsPatchSchema>;

export const nutrientTargetsResponseSchema = z
  .object({
    targets: z
      .record(
        z.string(),
        z.object({
          value: z.number(),
          direction: z.enum(["target", "limit"]),
        }),
      )
      .describe(
        "Only the codes that carry a target. Decode unknown keys leniently.",
      ),
  })
  .meta({
    id: "NutrientTargets",
    description:
      "The daily nutrient targets the user set, keyed by catalog code, each in the code's canonical unit.",
  });

/** Whether one stored entry is a valid target for `code`. */
export function parseNutrientTarget(
  code: NutrientCode,
  raw: unknown,
): NutrientTarget | null {
  const parsed = targetSchema(code).safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Read a stored value. Anything that does not parse (a hand-edited row, a
 * code a later release removed) reads code by code: a valid target survives,
 * an invalid one reads as not set. Never throws.
 */
export function parseNutrientTargets(raw: unknown): NutrientTargets {
  const out: NutrientTargets = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  const record = raw as Record<string, unknown>;
  for (const code of NUTRIENT_CODES) {
    const target = parseNutrientTarget(code, record[code]);
    if (target)
      out[code] = { value: target.value, direction: target.direction };
  }
  return out;
}

/**
 * Apply a validated PATCH: a code the body names replaces the stored target
 * (`null` clears it), a code it leaves out stays. Built code by code, never by
 * spreading the body.
 */
export function mergeNutrientTargets(
  current: NutrientTargets,
  patch: NutrientTargetsPatch,
): NutrientTargets {
  const next: NutrientTargets = {};
  for (const code of NUTRIENT_CODES) {
    const change = patch.targets[code];
    const kept = change === undefined ? current[code] : change;
    if (kept) next[code] = { value: kept.value, direction: kept.direction };
  }
  return next;
}

/** The codes that carry a target, in catalogue order. */
export function nutrientTargetCodes(targets: NutrientTargets): NutrientCode[] {
  return NUTRIENT_CODES.filter((code) => targets[code] !== undefined);
}

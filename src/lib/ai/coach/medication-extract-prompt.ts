/**
 * v1.5.0 — natural-language medication extraction prompt + schema.
 *
 * Step 1 of the new medication-create wizard ships an optional
 * "Beschreiben" overlay that runs the user's free-text description
 * ("Mounjaro 5mg weekly Wednesday morning starting next Monday")
 * through the Coach provider chain and pre-fills the wizard fields.
 *
 * This module owns the deterministic prompt assembly + the Zod schema
 * the response is validated against. Every field is optional — the
 * wizard merges the partial result onto whatever the user already
 * typed; the model is encouraged to leave a slot empty rather than
 * guess.
 *
 * Three load-bearing safety properties baked into the prompt:
 *
 *   1. Citation-coverage guard. The system prompt forbids inventing a
 *      `name` / `dose` pair that the user's text does not contain;
 *      `applyCitationGuard()` then post-validates each extracted token
 *      against the original text (case-insensitive substring) and drops
 *      anything that fails the check.
 *   2. Closed enums for `cadenceKind`, `doseUnit`, and `weekdays` — the
 *      Zod schema rejects every other token rather than echoing a
 *      model-hallucinated string back into the wizard.
 *   3. Bounded numeric ranges (`intervalWeeks`, `intervalMonths`,
 *      `dayOfMonth`, `rollingIntervalDays`) — a clamp on the schema
 *      layer so a `9999` answer cannot poison the form.
 */

import { z } from "zod/v4";

import {
  WEEKDAY_TOKENS,
  type CadenceKind,
  type WeekdayToken,
} from "@/components/medications/scheduling/types";

/** Closed list — matches the design-synthesis dose-unit dropdown. */
export const DOSE_UNITS = [
  "mg",
  "ml",
  "iu",
  "tablets",
  "drops",
  "puffs",
  "sprays",
] as const;

/** `CadenceKind` from the wizard types, mirrored as a Zod-friendly enum. */
export const CADENCE_KINDS = [
  "daily",
  "weekdays",
  "everyNWeeks",
  "monthly",
  "everyNMonths",
  "yearly",
  "rolling",
  "oneShot",
] as const;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Zod schema for the extracted medication payload. Every field is
 * optional; downstream wizard code merges the partial onto whatever the
 * user already typed. The bounds match the wizard's own primitives so
 * the merge target accepts every shape we emit here.
 */
export const medicationExtractionSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    dose: z.string().min(1).max(50).optional(),
    doseUnit: z.enum(DOSE_UNITS).optional(),
    cadenceKind: z.enum(CADENCE_KINDS).optional(),
    weekdays: z.array(z.enum(WEEKDAY_TOKENS)).max(7).optional(),
    intervalWeeks: z.number().int().min(1).max(52).optional(),
    intervalMonths: z.number().int().min(1).max(12).optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    rollingIntervalDays: z.number().int().min(1).max(365).optional(),
    timesOfDay: z
      .array(z.string().regex(HH_MM_RE, "HH:MM"))
      .max(12)
      .optional(),
    startsOn: z.string().regex(ISO_DATE_RE, "YYYY-MM-DD").optional(),
    endsOn: z.string().regex(ISO_DATE_RE, "YYYY-MM-DD").optional(),
    oneShot: z.boolean().optional(),
    confidence: z.record(z.string(), z.number().min(0).max(1)).optional(),
  })
  .strict();

export type MedicationExtractionResult = z.infer<
  typeof medicationExtractionSchema
>;

/**
 * Re-export the wizard `CadenceKind` + `WeekdayToken` types so callers
 * (the route, the tests) import a single module rather than chasing
 * the wizard types directory.
 */
export type { CadenceKind, WeekdayToken };

/**
 * Build the system prompt. Same shape across calls — the model only
 * sees the user's free text via `buildUserPrompt()`. The system prompt
 * itself carries the contract; we pin it as a snapshot test so a
 * silent drift surfaces in CI.
 */
export function buildMedicationExtractionSystemPrompt(): string {
  return [
    "You are HealthLog's medication-schedule extractor.",
    "",
    "TASK",
    "The user describes a medication course in free text (any locale).",
    "Return a single JSON object that fills the wizard's structured",
    "fields. Do not invent details the user did not write.",
    "",
    "OUTPUT SHAPE",
    "Reply with ONE JSON object (no prose, no Markdown, no code fences).",
    "Every field is optional — omit a field rather than guess. Keys:",
    "",
    "  name              — medication brand or active substance, verbatim",
    "  dose              — numeric portion only, as a string: \"5\", \"7.5\"",
    "  doseUnit          — one of: mg | ml | iu | tablets | drops | puffs | sprays",
    "  cadenceKind       — one of: daily | weekdays | everyNWeeks |",
    "                      monthly | everyNMonths | yearly | rolling |",
    "                      oneShot",
    "  weekdays          — array of RFC-5545 BYDAY tokens (MO,TU,WE,TH,",
    "                      FR,SA,SU), used with weekdays / everyNWeeks",
    "  intervalWeeks     — 1..52, used with everyNWeeks",
    "  intervalMonths    — 1..12, used with everyNMonths",
    "  dayOfMonth        — 1..31, used with monthly / everyNMonths",
    "  rollingIntervalDays — 1..365, used with rolling (\"every N days",
    "                      from the last intake\")",
    "  timesOfDay        — array of \"HH:MM\" wall-clock strings (24h)",
    "  startsOn          — ISO YYYY-MM-DD, course start date",
    "  endsOn            — ISO YYYY-MM-DD, course end date",
    "  oneShot           — true when the user describes a single-time",
    "                      dose (one flu shot, a single follow-up dose)",
    "  confidence        — optional { fieldName: number in [0,1] }",
    "                      so the wizard can render uncertainty",
    "",
    "GROUND RULES",
    "",
    "  1. Do NOT invent a name or dose the user did not write. If the",
    "     text does not name a medication, omit `name`. If the text does",
    "     not state a numeric dose, omit `dose` and `doseUnit`.",
    "",
    "  2. Map vague time-of-day words to canonical 24h slots:",
    "     morning → \"08:00\", noon / midday → \"12:00\",",
    "     afternoon → \"14:00\", evening → \"18:00\", night → \"22:00\".",
    "     Multiple times in one description → emit each as its own entry.",
    "",
    "  3. \"Every day\" / \"daily\" / \"once a day\" → `cadenceKind:",
    "     \"daily\"`. \"Twice a day\" / \"3 times a day\" → still",
    "     `daily` with the right `timesOfDay[]` count; never invent a",
    "     weekly cadence.",
    "",
    "  4. \"Every N days from my last injection / dose\" /",
    "     \"7 days after the previous one\" → `rolling` with",
    "     `rollingIntervalDays = N`. This is distinct from",
    "     `everyNWeeks` (calendar-anchored).",
    "",
    "  5. Single-shot wording (\"single flu shot\", \"one-off dose\",",
    "     \"on October 15 only\") → `oneShot: true` and a `startsOn`",
    "     date. Do not also emit `cadenceKind`.",
    "",
    "  6. Resolve relative dates against today's date supplied in the",
    "     CONTEXT block. \"Next Monday\", \"tomorrow\", \"in 2 weeks\"",
    "     become absolute ISO dates.",
    "",
    "  7. If a field is ambiguous, leave it empty. The wizard prefers",
    "     a missing slot over a confidently wrong one.",
    "",
    "  8. Output JSON only. No prose. No code fences. No comments.",
  ].join("\n");
}

export interface BuildUserPromptArgs {
  /** User's free-text description. */
  text: string;
  /** Reference date for relative phrases — ISO YYYY-MM-DD. */
  today: string;
  /** UI locale ("en" | "de" | …). Informational; the model handles any locale. */
  locale?: string;
}

/** Assemble the user-prompt body around the free-text description. */
export function buildMedicationExtractionUserPrompt(
  args: BuildUserPromptArgs,
): string {
  return [
    "CONTEXT",
    `today=${args.today}`,
    `locale=${args.locale ?? "en"}`,
    "",
    "DESCRIPTION",
    args.text.trim(),
    "",
    "Reply now with the JSON object only.",
  ].join("\n");
}

/**
 * Convenience: assemble both halves so snapshot tests can pin the full
 * payload without having to glue the two helpers together at every call
 * site.
 */
export function buildMedicationExtractionPrompt(
  args: BuildUserPromptArgs,
): { systemPrompt: string; userPrompt: string } {
  return {
    systemPrompt: buildMedicationExtractionSystemPrompt(),
    userPrompt: buildMedicationExtractionUserPrompt(args),
  };
}

/**
 * Citation-coverage guard. The system prompt forbids inventing
 * `name` / `dose` tokens, but a determined model may still hallucinate
 * — every commercial extractor we surveyed (R-1) does it occasionally.
 * Drop any extracted token whose lower-cased trimmed form is not a
 * substring of the original lower-cased trimmed text.
 *
 * Other fields stay (`cadenceKind`, `timesOfDay`, dates, intervals) —
 * those are normalised codes / numbers rather than verbatim quotes
 * from the user. A weekly cadence inferred from "every Monday" is
 * load-bearing inference, not hallucination.
 */
export function applyCitationGuard(
  result: MedicationExtractionResult,
  originalText: string,
): MedicationExtractionResult {
  const haystack = originalText.toLowerCase();
  const cleaned: MedicationExtractionResult = { ...result };

  if (cleaned.name) {
    const needle = cleaned.name.trim().toLowerCase();
    if (needle.length === 0 || !haystack.includes(needle)) {
      delete cleaned.name;
    }
  }

  if (cleaned.dose) {
    const needle = cleaned.dose.trim().toLowerCase();
    if (needle.length === 0 || !haystack.includes(needle)) {
      delete cleaned.dose;
      // The unit only makes sense alongside the dose; drop both
      // together so the wizard doesn't pre-fill a free-floating "mg".
      delete cleaned.doseUnit;
    }
  }

  return cleaned;
}

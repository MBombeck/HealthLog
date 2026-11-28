/**
 * v1.39 — request schemas for the three needs-onboarding writes.
 *
 * They live outside the route files for the reason `./onboarding.ts` gives: a
 * route module may only export handlers plus the Next.js route config, so the
 * OpenAPI registry cannot import a schema declared inside one. Keeping the
 * shapes here makes the published contract and the runtime parser the same
 * object.
 *
 * Prisma-free by construction — everything below reads its vocabulary from
 * `@/lib/onboarding/needs` and `@/lib/modules/registry`, both pure data.
 */
import { z } from "zod/v4";

import { MEDICINE_REGISTRY_CHOICES } from "@/lib/medications/leaflet-registries";
import { ONBOARDING_AREA_KEYS } from "@/lib/modules/registry";
import {
  ONBOARDING_FIRST_RESULT_TASKS,
  ONBOARDING_MEDICATION_ANSWERS,
  ONBOARDING_RECORD_TARGETS,
  ONBOARDING_SOURCE_KEYS,
  ONBOARDING_VISIT_ANSWERS,
} from "@/lib/onboarding/needs";
import { isValidTimezone } from "@/lib/tz/format";

/**
 * One answered step. `status` is optional and only ever `"done"` on this arm —
 * a skip is the separate arm below, so a body can never claim to skip a step
 * and carry an answer for it at the same time.
 */
function answered<Id extends string, Shape extends z.ZodRawShape>(
  id: Id,
  shape: Shape,
) {
  return z
    .object({
      step: z.literal(id),
      status: z.literal("done").optional(),
      ...shape,
    })
    .strict();
}

/** One deliberately passed step. No answer may ride along. */
function skipped<Id extends string>(id: Id) {
  return z
    .object({ step: z.literal(id), status: z.literal("skipped") })
    .strict();
}

/**
 * The "Region & units" answers. Every field is optional and the unit fields
 * nullable: the screen asks each one only where it applies (a unit for an area
 * that needs it, the registry when medication was chosen) and may set one
 * without the others. The route writes the record's real columns from these
 * (`glucoseUnit`, `unitPreference`, `timezone`, `medicineRegistry`) and
 * records the answer beside them. `timezone` and `medicineRegistry` are new in
 * 1.49; a body without them changes nothing it changed before.
 */
export const onboardingUnitsSchema = z
  .object({
    glucoseUnit: z.enum(["mg/dL", "mmol/L"]).nullable().optional(),
    unitPreference: z.enum(["metric", "imperial"]).nullable().optional(),
    timezone: z
      .string()
      .trim()
      .max(64)
      .refine(isValidTimezone, { message: "Not a valid IANA time zone" })
      .optional(),
    medicineRegistry: z.enum(MEDICINE_REGISTRY_CHOICES).optional(),
  })
  .strict();

/**
 * The task the flow ended on. `completed` is what turns the offer into a
 * result — the server stamps the instant rather than taking one from the
 * client, so a replay cannot backdate it.
 */
export const onboardingFirstResultSchema = z
  .object({
    task: z.enum(ONBOARDING_FIRST_RESULT_TASKS),
    target: z.string().trim().min(1).max(64).nullable().optional(),
    completed: z.boolean().optional(),
  })
  .strict();

/**
 * `PATCH /api/onboarding/answers` — one step at a time.
 *
 * A flat union rather than a discriminated one: each step id appears twice
 * (answered and skipped) and `z.discriminatedUnion` needs one option per
 * literal. The three steps that are not questions — `who` is required, and
 * `confirm` / `done` are acknowledgements — have no skip arm, so a client
 * cannot record a pass through a screen that does not offer one.
 */
export const onboardingAnswerSchema = z.union([
  answered("who", { recordTarget: z.enum(ONBOARDING_RECORD_TARGETS) }),
  answered("areas", {
    areas: z
      .array(z.enum(ONBOARDING_AREA_KEYS))
      .max(ONBOARDING_AREA_KEYS.length),
  }),
  answered("medication", {
    medication: z.enum(ONBOARDING_MEDICATION_ANSWERS),
  }),
  answered("sources", {
    sources: z
      .array(z.enum(ONBOARDING_SOURCE_KEYS))
      .max(ONBOARDING_SOURCE_KEYS.length),
  }),
  answered("visit", { visit: z.enum(ONBOARDING_VISIT_ANSWERS) }),
  answered("units", { units: onboardingUnitsSchema }),
  // "Someone I look after": the profile the person just created, so the
  // answers land on that record. Without it the confirm stamps the flow and
  // derives nothing (the profile can follow later from Settings).
  answered("confirm", {
    managedRecordId: z.string().trim().min(1).max(64).optional(),
  }),
  // The two follow-ups (1.49) record only that the screen was answered: what
  // they change has its own route (the channel cards, the AI consent and the
  // Coach switch), so the ledger never becomes a second writer of it.
  answered("reminders", {}),
  answered("ai", {}),
  answered("first-result", { firstResult: onboardingFirstResultSchema }),
  answered("done", {}),
  skipped("areas"),
  skipped("medication"),
  skipped("sources"),
  skipped("visit"),
  skipped("units"),
  skipped("reminders"),
  skipped("ai"),
  skipped("first-result"),
]);

export type OnboardingAnswerInput = z.infer<typeof onboardingAnswerSchema>;

/**
 * `POST /api/onboarding/restart` — no input beyond the session. Strict and
 * empty rather than unvalidated, so a client that starts sending a field gets
 * a 422 that names it instead of having it silently ignored.
 */
export const onboardingRestartSchema = z.object({}).strict();

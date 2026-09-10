/**
 * v1.39 (C1) — request schemas for the three needs-onboarding writes.
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

import { ONBOARDING_AREA_KEYS } from "@/lib/modules/registry";
import {
  ONBOARDING_FIRST_RESULT_TASKS,
  ONBOARDING_MEDICATION_ANSWERS,
  ONBOARDING_RECORD_TARGETS,
  ONBOARDING_SOURCE_KEYS,
  ONBOARDING_VISIT_ANSWERS,
} from "@/lib/onboarding/needs";

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
 * Q6 — the unit answers. Both fields are optional and nullable: the screen
 * only appears when glucose or weight is among the areas, and it may set one
 * without the other. The route writes the record's real display columns from
 * these and records the answer beside them.
 */
export const onboardingUnitsSchema = z
  .object({
    glucoseUnit: z.enum(["mg/dL", "mmol/L"]).nullable().optional(),
    unitPreference: z.enum(["metric", "imperial"]).nullable().optional(),
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
  answered("confirm", {}),
  answered("first-result", { firstResult: onboardingFirstResultSchema }),
  answered("done", {}),
  skipped("areas"),
  skipped("medication"),
  skipped("sources"),
  skipped("visit"),
  skipped("units"),
  skipped("first-result"),
]);

export type OnboardingAnswerInput = z.infer<typeof onboardingAnswerSchema>;

/**
 * `POST /api/onboarding/restart` — no input beyond the session. Strict and
 * empty rather than unvalidated, so a client that starts sending a field gets
 * a 422 that names it instead of having it silently ignored.
 */
export const onboardingRestartSchema = z.object({}).strict();

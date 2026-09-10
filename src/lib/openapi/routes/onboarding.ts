/**
 * OpenAPI route table — the onboarding wizard and the module tour.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * The request schemas come from `src/lib/onboarding/tour-progress.ts` and
 * `src/lib/validations/onboarding.ts` so the wire contract stays
 * single-source with the runtime parsers.
 *
 * Two generations of the same flow live side by side here, and a client
 * should pick one. `POST /api/onboarding/step` is the current wizard: four
 * ordered checkpoints, the fourth of which completes. `POST
 * /api/onboarding/complete` is the older single-shot path that stamps the
 * completion and takes whatever profile fields it was given. They write the
 * same column and refuse to co-operate — the step route's conditional update
 * requires `onboardingCompletedAt: null`, so a `complete` call mid-wizard
 * makes every remaining step 409.
 *
 * v1.18.6 — the resumable module-tour contract the iOS client mirrors:
 * a fire-and-forget progress checkpoint plus the coarse completion
 * flip. The resume point also rides `GET /api/auth/me` as
 * `onboardingTourProgress`.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import {
  ONBOARDING_FIRST_RESULT_TASKS,
  ONBOARDING_MEDICATION_ANSWERS,
  ONBOARDING_RECORD_TARGETS,
  ONBOARDING_SOURCE_KEYS,
  ONBOARDING_STEP_IDS,
  ONBOARDING_STEP_STATUSES,
  ONBOARDING_VISIT_ANSWERS,
} from "@/lib/onboarding/needs";
import { tourProgressSchema } from "@/lib/onboarding/tour-progress";
import { ONBOARDING_AREA_KEYS } from "@/lib/modules/registry";
import {
  onboardingCompleteSchema,
  onboardingStepSchema,
} from "@/lib/validations/onboarding";
import {
  onboardingAnswerSchema,
  onboardingRestartSchema,
} from "@/lib/validations/onboarding-needs";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

/* ── v1.39 (C1): the needs-based flow ─────────────────────────────────────── */

const onboardingNeedsResource = z
  .object({
    recordTarget: z
      .enum(ONBOARDING_RECORD_TARGETS)
      .nullable()
      .describe("Q1 — whose record this is. Null until answered."),
    areas: z
      .array(z.enum(ONBOARDING_AREA_KEYS))
      .describe(
        "Q2 — the areas to keep an eye on. Each one maps to at least one module through `ONBOARDING_AREA_MODULES`; the map is the server's, and a client must not re-derive it.",
      ),
    medication: z
      .enum(ONBOARDING_MEDICATION_ANSWERS)
      .nullable()
      .describe("Q3 — medication on a schedule."),
    sources: z
      .array(z.enum(ONBOARDING_SOURCE_KEYS))
      .describe("Q4 — where the readings come from today."),
    visit: z
      .enum(ONBOARDING_VISIT_ANSWERS)
      .nullable()
      .describe("Q5 — a doctor's visit coming up."),
    units: z
      .object({
        glucoseUnit: z.enum(["mg/dL", "mmol/L"]).nullable(),
        unitPreference: z.enum(["metric", "imperial"]).nullable(),
      })
      .describe(
        "Q6 — the unit answers as given. NOT the source of truth for display: `glucoseUnit` and `unitPreference` on the account payload are, and the answers step writes them. This records what the flow was told.",
      ),
  })
  .meta({
    id: "OnboardingNeeds",
    description:
      "The setup answers as given. Every field is null or empty until its question is answered.",
  });

const onboardingStepResource = z
  .object({
    id: z.enum(ONBOARDING_STEP_IDS),
    status: z.enum(ONBOARDING_STEP_STATUSES),
  })
  .meta({
    id: "OnboardingStepState",
    description:
      "One step of the setup flow. The ids are stable; a client that meets one it does not know SKIPS it rather than refusing the list, so the flow may grow a screen without a client release.\n\n`units` carries one resolution the others do not: a record whose account already holds BOTH unit preferences reads as `done` whether or not the question was ever put, which is what stops the flow re-asking a value the account holds.",
  });

const onboardingFirstResultResource = z
  .object({
    task: z.enum(ONBOARDING_FIRST_RESULT_TASKS),
    target: z
      .string()
      .nullable()
      .describe(
        "What the task is about — a source key for a connection, an area key for a reading. Null for the medication task.",
      ),
    completedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe("When the offered task produced its result, or null."),
  })
  .meta({
    id: "OnboardingFirstResult",
    description:
      "The one task the flow offered at the end, and whether it produced its result.",
  });

export const onboardingStateResource = z
  .object({
    steps: z.array(onboardingStepResource),
    needs: onboardingNeedsResource,
    completedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "When the needs flow was completed. Distinct from the account payload's `onboardingCompletedAt`, which stays the first-run redirect's gate: `POST /api/onboarding/restart` clears this one and leaves that one alone.",
      ),
    firstResult: onboardingFirstResultResource.nullable(),
  })
  .meta({
    id: "OnboardingState",
    description:
      "The needs-based setup flow for one record. Always present on the account payload — a record that never entered the flow reads as empty answers with nine `pending` steps, so a client branches on the step statuses rather than on the field's existence.",
  });

const onboardingStateEnvelope = dataEnvelope(
  z.object({ onboarding: onboardingStateResource }),
  "OnboardingStateEnvelope",
);

const onboardingAnswerRequest = onboardingAnswerSchema.meta({
  id: "OnboardingAnswerRequest",
  description:
    "One step, answered or deliberately passed. The union has an arm per step id plus a skip arm for the six steps that may be passed — `who` is the one required question, and `confirm` / `done` are acknowledgements rather than questions, so none of the three has a skip arm. Every arm is strict: an unknown key is a 422, and a skip may never carry an answer.",
});

const onboardingRestartRequest = onboardingRestartSchema.meta({
  id: "OnboardingRestartRequest",
  description: "No input beyond the session. Send `{}`.",
});

const tourProgressResource = tourProgressSchema.meta({
  id: "TourProgress",
  description:
    "Resumable module-tour progress point. `lastStopId` seeds the resume index; `status` is the running/terminal state.",
});

const tourUpdateRequest = z
  .object({
    completed: z
      .boolean()
      .optional()
      .describe(
        "Flip the coarse completion flag. `false` is a replay reset and clears the stored progress point.",
      ),
    outcome: z
      .enum(["completed", "skipped"])
      .optional()
      .describe("Informational — distinguishes reaching the end from a skip."),
    progress: tourProgressResource
      .optional()
      .describe(
        "Mid-tour resume checkpoint. May arrive alone or with `completed`.",
      ),
  })
  .meta({
    id: "TourUpdateRequest",
    description:
      "Update the module-tour state. Provide `completed` and/or `progress`.",
  });

const tourUpdateResponse = z
  .object({
    onboardingTourCompleted: z.boolean(),
    progress: tourProgressResource.nullable(),
  })
  .meta({
    id: "TourUpdateResponse",
    description:
      "The persisted completion flag and resume point after the write.",
  });

const disclaimerAckRequest = z
  .object({
    version: z
      .string()
      .min(1)
      .max(64)
      .describe(
        "The disclaimer copy version the client rendered. A freshness signal only — the server pins and persists its own canonical version.",
      ),
  })
  .meta({
    id: "DisclaimerAckRequest",
    description:
      "Acknowledge the one-time medical disclaimer shown at onboarding.",
  });

const disclaimerAckResponse = z
  .object({
    acknowledgedVersion: z
      .string()
      .describe("The canonical disclaimer version the server stamped."),
  })
  .meta({
    id: "DisclaimerAckResponse",
    description: "The persisted disclaimer acknowledgment version.",
  });

const onboardingStepRequest = onboardingStepSchema.meta({
  id: "OnboardingStepRequest",
  description:
    "The wizard step being COMPLETED, 1–4. It must equal the stored step plus one — the server does not clamp or skip. `goals` rides the step-2 submit; every slug is checked against the closed set, so one unknown slug fails the whole request rather than being dropped.",
});

const onboardingStepResponse = z
  .object({
    step: z.number().int().describe("The stored step after the write."),
    onboardingCompletedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe("Non-null once step 4 landed."),
  })
  .meta({ id: "OnboardingStepResponse" });

const onboardingCompleteRequest = onboardingCompleteSchema.meta({
  id: "OnboardingCompleteRequest",
  description:
    "Optional profile fields to save alongside the completion stamp. Every field is optional and only a truthy value is written — sending `heightCm: 0` or an empty `displayName` leaves the column alone rather than clearing it. There is no way to CLEAR a field through this endpoint. `dateOfBirth` is a free string parsed with `new Date(...)`: an unparseable value is silently ignored, not refused.",
});

export const onboardingPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/onboarding/answers": {
    patch: {
      tags: ["Onboarding"],
      summary: "Save one answer of the needs-based setup flow",
      description:
        "Persists one step of the setup questionnaire the moment it is answered, so leaving and returning resumes at the same step. The body names the step and carries either its answer or `status: \"skipped\"`; the two can never ride together.\n\nIdempotent. The stored state is computed by a pure function of the row and the body, so sending the same step twice writes the same value and the second write changes nothing a reader can see — including the first-result completion instant, which is kept from the existing row rather than re-taken. There is no ordering contract: steps may be answered, re-answered and passed in any order, which is what makes a back button work.\n\nThe `units` step is the one answer with a consequence outside this state: it writes the record's `glucoseUnit` and `unitPreference`, which every display surface already reads, and records the answer beside them.\n\nCookie or wildcard Bearer, and the CALLER's own record only: a request made while the session is acting on somebody else's record is refused with 403 `sharing.not_permitted` at every grant level, so a delegate can never write another record's setup. Rate-limited to 120 writes per 10 minutes per account.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: onboardingAnswerRequest } },
      },
      responses: {
        "200": {
          description: "The full setup state after the write.",
          content: {
            "application/json": { schema: onboardingStateEnvelope },
          },
        },
        "413": {
          description: "Body exceeds 16 KiB.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "415": {
          description: "`Content-Type` is not `application/json`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "The body did not validate. `meta.errorCode` = `onboarding.answers.invalid`, with every issue on the wire.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description:
            "More than 120 answer writes in 10 minutes. `meta.errorCode` = `onboarding.answers.rateLimited`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/onboarding/restart": {
    post: {
      tags: ["Onboarding"],
      summary: "Ask the setup questions again",
      description:
        "\"Set up again\", from Settings. Puts the nine steps back to `pending`, clears the flow's own completion stamp, and clears the derivation marker so the next `POST /api/onboarding/complete` may derive a module map again.\n\nIt writes no module state at all: the ordering-versus-removal decision says a re-run never turns off a module somebody turned on by hand, and the protection against the second derivation lives in the merge rather than here. It also keeps the answers, as the prefill for the re-run, keeps a first result that really happened, and leaves the account payload's `onboardingCompletedAt` alone so nobody is pushed back through the first-run redirect.\n\nCookie or wildcard Bearer, own record only — same refusal under a switch as the answers route. Rate-limited to 10 restarts per 10 minutes per account.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: onboardingRestartRequest } },
      },
      responses: {
        "200": {
          description: "The reset setup state.",
          content: {
            "application/json": { schema: onboardingStateEnvelope },
          },
        },
        "413": {
          description: "Body exceeds 4 KiB.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "415": {
          description: "`Content-Type` is not `application/json`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "The body carried a field. `meta.errorCode` = `onboarding.restart.invalid`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description:
            "More than 10 restarts in 10 minutes. `meta.errorCode` = `onboarding.restart.rateLimited`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/onboarding/step": {
    post: {
      tags: ["Onboarding"],
      summary: "Advance the onboarding wizard by one step",
      description:
        "Persists progress through the four-step wizard. The contract is strictly ordered: the submitted `step` must be exactly the stored step plus one, so a client cannot skip ahead or replay a step it already sent.\n\nSubmitting step 4 completes onboarding — the completion instant is stamped in the same write, the proxy-readable pending cookie is cleared so the next navigation stops redirecting to `/onboarding`, and the stored goal selection seeds the dashboard layout. That seed is ONE-TIME and conditional: it only runs while the layout column is still unset, so a person who already arranged their tiles is never clobbered, and a concurrent layout save that lands first wins.\n\nThe write is guarded on the state it validated, so two tabs submitting the same step do not both succeed — exactly one lands and the other gets 409.\n\nRate-limited to 30 writes per 10 minutes per user, which is generous for a four-step flow and tight enough to defang a stuck retry loop. Every accepted call writes an audit row. Cookie or wildcard Bearer; `userId` is never read from the body.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: onboardingStepRequest } },
      },
      responses: {
        "200": {
          description: "The stored step and completion stamp after the write.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                onboardingStepResponse,
                "OnboardingStepEnvelope",
              ),
            },
          },
        },
        "404": {
          description:
            "The session's user row no longer exists. `meta.errorCode` = `onboarding.user.notFound`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "The write was refused and nothing changed. `meta.errorCode` distinguishes three cases: `onboarding.step.completed` — onboarding is already finished, so the wizard has nothing left to advance; `onboarding.step.outOfOrder` — the submitted step is not the stored step plus one, and the message names the current step; `onboarding.step.concurrent` — the row moved between the check and the write, which is what a second tab sees.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "Body exceeds 64 KiB.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "415": {
          description: "`Content-Type` is not `application/json`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "The body did not validate. `meta.errorCode` = `onboarding.step.invalid`. Single-message, not the multi-issue envelope — the per-field detail is not on the wire.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description:
            "More than 30 onboarding writes in 10 minutes. `meta.errorCode` = `onboarding.step.rateLimited`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/onboarding/complete": {
    post: {
      tags: ["Onboarding"],
      summary: "Stamp onboarding as complete, and derive the module map",
      description:
        "Marks onboarding finished and saves whatever profile fields came with it, then clears the proxy-readable pending cookie so the next navigation stops redirecting to `/onboarding`.\n\nv1.39 — this is also the needs-based flow's confirm endpoint, and the two halves live side by side. For a record that FINISHED the questions — every one of them answered or deliberately passed — it derives that record's module map from the answers and applies it, ONCE: the derivation marker is what stops a second confirm re-applying the questionnaire over decisions taken in Settings since, and `POST /api/onboarding/restart` clears the marker when the person asks for the questions again. The merge is one-directional — a module the answers name is switched on, a module they do not name is switched off only where the record does not already carry an explicit on. The `cycle` key is not written here at all: it delegates to the cycle profile, which this route sets to `true` when the cycle area was chosen and never to `false`. A half-answered flow derives nothing and is not stamped as complete: the answers become a module map, and a flow somebody abandoned after the first screen would have every remaining question read as its conservative default. The same gate is what keeps the LEGACY wizard's completion out of the derivation, since that wizard never puts these questions.\n\nThe response then carries `onboarding` beside `completed`; a caller that never entered the needs flow gets the fixed acknowledgement it always did.\n\nThe older sibling of `POST /api/onboarding/step`. It is unconditional in a way the step route is not: it stamps the completion whatever the stored step is, it re-stamps on every call rather than refusing a second one, and it enforces no rate limit of its own. Its legacy half writes no audit row; the needs half writes one (`user.modules.update`) when it derives, because that is the same column the dedicated modules route audits. It also does NOT seed the dashboard from the goal selection — that only happens on the step route's completing call.\n\nCalling this mid-wizard makes every remaining `POST /api/onboarding/step` answer 409 `onboarding.step.completed`, because that route's guarded update requires the completion stamp to still be null.\n\nCookie or wildcard Bearer; `userId` is never read from the body.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: onboardingCompleteRequest } },
      },
      responses: {
        "200": {
          description:
            "Onboarding stamped complete. `completed` is the fixed acknowledgement — it does not echo the profile fields that were saved. `onboarding` is present only for a record that entered the needs-based flow, and carries the state after the derivation.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  completed: z.literal(true),
                  onboarding: onboardingStateResource.optional(),
                }),
                "OnboardingCompleteEnvelope",
              ),
            },
          },
        },
        "413": {
          description: "Body exceeds 64 KiB.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "415": {
          description: "`Content-Type` is not `application/json`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "The body did not validate. `meta.errorCode` = `onboarding.complete.invalid`. Single-message, not the multi-issue envelope.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/onboarding/disclaimer": {
    post: {
      tags: ["Onboarding"],
      summary: "Acknowledge the one-time medical disclaimer",
      description:
        "Stamps the user's medical-disclaimer acknowledgment. Idempotent: a repeat acknowledgment of the same version refreshes the timestamp. The body version is a freshness signal so a stale shell cannot record copy it never rendered; the server persists its own canonical version.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: disclaimerAckRequest } },
      },
      responses: {
        "200": {
          description: "Disclaimer acknowledged.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                disclaimerAckResponse,
                "DisclaimerAckEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/onboarding/tour": {
    post: {
      tags: ["Onboarding"],
      summary: "Update module-tour completion + resume point",
      description:
        "Persists the module-tour state. The client posts a fire-and-forget `progress` checkpoint on each step so a reload resumes at the right module, and a terminal `completed:true` with `outcome` when the tour ends. `completed:false` is a replay reset that also clears the resume point.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: tourUpdateRequest } },
      },
      responses: {
        "200": {
          description: "Tour state updated.",
          content: {
            "application/json": {
              schema: dataEnvelope(tourUpdateResponse, "TourUpdateEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};

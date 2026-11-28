/**
 * OpenAPI route table — the resolved setup state (1.50). Part of the OpenAPI
 * route table; aggregated in `./index.ts`.
 *
 * The request schema is the runtime parser itself
 * (`src/lib/validations/setup.ts`); the response vocabularies are the
 * resolver's own (`src/lib/setup/types.ts`).
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import {
  INSTANCE_TASK_IDS,
  PERSON_SCREEN_IDS,
  PERSON_SEGMENT_IDS,
  PERSON_TASK_IDS,
  SERVER_SETUP_STEP_IDS,
  SETUP_TASK_STATUSES,
  SETUP_TASK_VALUES,
} from "@/lib/setup/types";
import { SERVER_SETUP_STEP_STATUSES } from "@/lib/admin/server-setup";
import { isoDateTime } from "@/lib/validations/datetime";
import { setupPatchSchema } from "@/lib/validations/setup";

import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

function setupTask<T extends readonly [string, ...string[]]>(ids: T) {
  return z.object({
    id: z.enum(ids),
    status: z
      .enum(SETUP_TASK_STATUSES)
      .describe(
        "todo waits; done is set up; declined is an explicit no, settled and never asked again; warning is a detected problem or a deadline under seven days.",
      ),
    value: z
      .enum(SETUP_TASK_VALUES)
      .nullable()
      .describe("What a settled row shows (closed vocabulary), or null."),
    deadline: isoDateTime()
      .nullable()
      .describe("The second-factor policy's date, while it applies."),
    deadlineDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .describe(
        "The deadline's calendar day (YYYY-MM-DD) in the profile's time zone: the day to show. Null without a deadline.",
      ),
    deadlineTimeZone: z
      .string()
      .nullable()
      .describe(
        "The IANA zone the deadline is read in (the profile's). Null without a deadline.",
      ),
    count: z
      .object({ done: z.number().int(), total: z.number().int() })
      .nullable()
      .describe("For a row that is a group (services configured)."),
  });
}

const personState = z.object({
  firstRunOwed: z
    .boolean()
    .describe(
      "The first run is still owed: the account is not stamped complete, the same gate as the web's first-run redirect. Show the setup flow exactly when this is true; it turns false when the last owed screen is answered (the server confirms on that write).",
    ),
  status: z.enum(["pending", "done"]),
  currentStep: z
    .enum(PERSON_SCREEN_IDS)
    .nullable()
    .describe("The screen the flow resumes on; null when nothing is owed."),
  segments: z
    .array(
      z.object({
        id: z.enum(PERSON_SEGMENT_IDS),
        screens: z.array(
          z.object({
            id: z.enum(PERSON_SCREEN_IDS),
            status: z.enum(["pending", "done", "skipped"]),
          }),
        ),
      }),
    )
    .describe(
      "The segments pinned when the flow started (fixed for the flow), each with its screens. Clients map screen ids to their own screens and skip an id they do not know.",
    ),
  planned: z
    .boolean()
    .describe("The flow started on 1.50, so its segments are pinned."),
  cardShown: z
    .boolean()
    .describe("Whether the dashboard shows the setup card."),
  cardDismissed: z
    .boolean()
    .describe(
      "The person hid the setup card (PATCH /api/setup). Only the card: the rows stay in Settings › Account › Setup. `cardShown` already accounts for it.",
    ),
  tasks: z.array(setupTask(PERSON_TASK_IDS)),
});

const instanceState = z.object({
  status: z.enum(["pending", "done"]),
  currentStep: z.enum(SERVER_SETUP_STEP_IDS).nullable(),
  steps: z.array(
    z.object({
      id: z.enum(SERVER_SETUP_STEP_IDS),
      status: z.enum(SERVER_SETUP_STEP_STATUSES),
    }),
  ),
  tasks: z.array(setupTask(INSTANCE_TASK_IDS)),
});

const setupState = z
  .object({
    person: personState,
    instance: instanceState
      .nullable()
      .describe("Admins on a browser session only; null on a Bearer token."),
    offers: z.object({
      relay: z.enum(["on", "off", "undecided"]),
      ai: z
        .boolean()
        .describe("A provider can serve the Coach for this record now."),
    }),
  })
  .meta({ id: "SetupState" });

const setupEnvelope = dataEnvelope(setupState, "SetupStateEnvelope");

export const setupPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/setup": {
    get: {
      tags: ["Onboarding"],
      summary: "The resolved setup state",
      description:
        "Where the person setup stands and the rows of the setup card, resolved on the server so the web and the iPhone app render the same thing; for an admin on a browser session also the server setup and the rows of Admin › Setup. Rows are detected from their domain (a medication exists, a factor is enrolled, the relay is on), so a row completes wherever it was done. Cookie or wildcard Bearer; a narrow token is refused. Feature key `setup.resolved-state`.",
      responses: {
        "200": {
          description: "The setup state.",
          content: { "application/json": { schema: setupEnvelope } },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Onboarding"],
      summary: "Hide or show the setup card",
      description:
        "`cardDismissed: true` hides the dashboard setup card for this account on every device; `false` clears the hide, and the card comes back only while `cardShown`'s other conditions hold (a flow started on 1.50, at least one row `todo` or `warning`, not a demo deploy); it touches no row and nothing else. Settings › Account › Setup lists the same rows either way. Refused on a demo deploy (403 `setup.demo`). Rate-limited to 30 writes per 10 minutes. Cookie or wildcard Bearer.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: setupPatchSchema.meta({ id: "SetupPatchRequest" }),
          },
        },
      },
      responses: {
        "200": {
          description: "The setup state after the write.",
          content: { "application/json": { schema: setupEnvelope } },
        },
        "403": {
          description: "A demo deploy.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
};

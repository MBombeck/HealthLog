/**
 * OpenAPI route table — the first-admin server setup and its health check
 * (1.49). Part of the OpenAPI route table; aggregated in `./index.ts`.
 *
 * Admin-only and cookie-only (`requireAdmin`): no Bearer token, wildcard or
 * not, reaches these, and the native app is not an admin client. The request
 * schema is the runtime parser itself (`src/lib/validations/server-setup.ts`).
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import {
  SERVER_SETUP_STEP_IDS,
  SERVER_SETUP_STEP_STATUSES,
} from "@/lib/admin/server-setup";
import { SETUP_HEALTH_SIGNALS } from "@/lib/admin/setup-health-model";
import { isoDateTime } from "@/lib/validations/datetime";
import { serverSetupStepPatchSchema } from "@/lib/validations/server-setup";

import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

const serverSetupState = z
  .object({
    offered: z
      .boolean()
      .describe(
        "False on a demo deploy, where the setup screens refuse and nothing points at them.",
      ),
    completedAt: isoDateTime()
      .nullable()
      .describe(
        "When the setup was finished; null while it is offered. An instance that had accounts before 1.49 was stamped by its migration.",
      ),
    steps: z
      .array(
        z.object({
          id: z.enum(SERVER_SETUP_STEP_IDS),
          status: z.enum(SERVER_SETUP_STEP_STATUSES),
        }),
      )
      .describe("Every step, in order. A missing stored step reads pending."),
    noticePending: z
      .boolean()
      .describe(
        "Whether the start-page notice shows for the calling admin: offered, not finished, not dismissed by this admin.",
      ),
    facts: z
      .object({
        oidc: z.object({ configured: z.boolean(), only: z.boolean() }),
        smtp: z.object({
          configured: z.boolean(),
          missing: z
            .array(z.string())
            .describe("Names of the required SMTP variables that are unset."),
        }),
        telegram: z.object({ webhookSecret: z.boolean() }),
      })
      .describe(
        "What the environment says, as booleans and variable names. Never a value.",
      ),
  })
  .meta({ id: "AdminServerSetupState" });

const setupHealth = z
  .object({
    state: z.enum(["ok", "attention", "failing"]),
    signals: z.array(
      z.object({
        id: z.enum(SETUP_HEALTH_SIGNALS),
        state: z.enum(["ok", "attention", "failing"]),
        reason: z
          .string()
          .describe(
            "A closed code per signal, rendered as `admin.setupHealth.reason.<id>.<reason>`.",
          ),
        params: z
          .record(z.string(), z.union([z.string(), z.number()]))
          .describe("Values the sentence interpolates. Never a secret."),
        fixPath: z.string().nullable(),
        docsUrl: z.string(),
      }),
    ),
  })
  .meta({ id: "AdminSetupHealth" });

const stateEnvelope = dataEnvelope(
  serverSetupState,
  "AdminServerSetupStateEnvelope",
);

export const adminServerSetupPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/admin/server-setup": {
    get: {
      tags: ["Admin"],
      summary: "The first-admin server setup's state",
      description:
        "The steps (accounts, notifications, ai, privacy, health), the finish stamp, whether the start-page notice shows for this admin, and the environment facts the steps show. Admin-only, cookie-only.",
      responses: {
        "200": {
          description: "The setup state.",
          content: { "application/json": { schema: stateEnvelope } },
        },
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Admin"],
      summary: "Record one server setup step",
      description:
        "Marks one step done or skipped. The settings themselves are saved by each step's own admin routes; this records the step. When every step is settled the setup is stamped finished, once. Refused on a demo deploy (409 `admin.serverSetup.notOffered`). Rate-limited to 60 writes per 10 minutes per admin. Admin-only, cookie-only, audit-logged.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: serverSetupStepPatchSchema.meta({
              id: "AdminServerSetupStepRequest",
            }),
          },
        },
      },
      responses: {
        "200": {
          description: "The setup state after the write.",
          content: { "application/json": { schema: stateEnvelope } },
        },
        "409": {
          description: "The setup is not offered on this server (demo).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/admin/server-setup/notice": {
    post: {
      tags: ["Admin"],
      summary: "Dismiss the server setup notice",
      description:
        "Hides the start-page notice for the calling admin. The setup stays reachable from Admin, System status. Admin-only, cookie-only.",
      responses: {
        "200": {
          description: "Dismissed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ dismissed: z.literal(true) }),
                "AdminServerSetupNoticeEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/admin/setup-health": {
    get: {
      tags: ["Admin"],
      summary: "The setup health check list",
      description:
        "Read-only signals: encryption keys present, the secure-cookie setting against how this request arrived, the database dump schedule, the public URL. Closed reason codes, key ids and counts only. Admin-only, cookie-only.",
      responses: {
        "200": {
          description: "The signals and the worst state.",
          content: {
            "application/json": {
              schema: dataEnvelope(setupHealth, "AdminSetupHealthEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};

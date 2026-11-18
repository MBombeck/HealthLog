/**
 * OpenAPI route table — Antigravity CLI provider: setup status, login steps,
 * the connection test and disconnect.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The response
 * bodies mirror the handlers under `src/app/api/antigravity/*`.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import {
  antigravityInstallSchema,
  antigravityModelPatchSchema,
} from "@/lib/validations/antigravity";
import { dataEnvelope, stdResponses } from "./shared";

const connectionStatus = z
  .enum(["disconnected", "connected", "auth_required", "error"])
  .describe("State of the profile as of the last connection test.");

const promptCapabilities = z
  .object({
    image: z.boolean(),
    embeddedContext: z
      .boolean()
      .describe(
        "Embedded resources such as PDFs. The CLI calls this embeddedContext.",
      ),
  })
  .describe(
    "Prompt input the CLI accepted in its last successful connection test.",
  );

const antigravityStatusResponse = z.object({
  cliInstalled: z.boolean(),
  cliVersion: z.string().nullable(),
  canInstallCli: z
    .boolean()
    .describe(
      "Whether the signed-in user is an administrator and may install the CLI.",
    ),
  canUpdateCli: z
    .boolean()
    .describe(
      "Whether the signed-in user is an administrator and may update an eligible HealthLog-managed binary.",
    ),
  cliManaged: z
    .boolean()
    .describe(
      "Whether the detected binary is managed by HealthLog in the profile directory rather than externally managed.",
    ),
  updateAvailable: z
    .boolean()
    .describe(
      "Whether an update to the latest available release is available for the managed binary.",
    ),
  latestVersion: z
    .string()
    .nullable()
    .describe(
      "The latest available Antigravity CLI version from official GitHub releases, or null if discovery failed.",
    ),
  profileId: z.string().nullable(),
  connectionStatus,
  connectedAt: z.string().nullable(),
  capabilities: promptCapabilities.nullable(),
});

const antigravityAuthStartResponse = z.object({
  authUrl: z.string(),
  profileId: z.string(),
});

const antigravityAuthSubmitResponse = z.object({
  success: z.boolean(),
  status: connectionStatus,
});

const antigravityAuthCancelResponse = z.object({
  success: z.boolean(),
});

const antigravityInstallResponse = z.object({
  version: z.string().optional(),
  binaryPath: z.string(),
  alreadyInstalled: z.boolean(),
});

const antigravityTestResponse = z.object({
  status: connectionStatus,
  reason: z
    .enum([
      "not_set_up",
      "profile_missing",
      "cli_unavailable",
      "auth_required",
      "timeout",
      "cli_error",
    ])
    .nullable()
    .describe("Why the test did not pass. Null when the profile is connected."),
  capabilities: promptCapabilities.nullable(),
});

const antigravityModel = z.object({
  id: z.string().describe("Model id as the CLI names it."),
  name: z.string(),
});

const antigravityModelsResponse = z.object({
  models: z.array(antigravityModel),
  selectedModel: z
    .string()
    .nullable()
    .describe("The model the user picked, or null for the CLI's default."),
  thoughtLevels: z.array(z.string()).nullable().optional(),
  reason: z
    .enum([
      "not_set_up",
      "profile_missing",
      "cli_unavailable",
      "auth_required",
      "timeout",
      "cli_error",
      "no_models",
    ])
    .nullable()
    .describe("Why `models` is empty. Null when the CLI offered models."),
});

const antigravityModelResponse = z.object({
  selectedModel: z.string().nullable(),
});

const antigravityDisconnectResponse = z.object({
  success: z.boolean(),
  loginRemoved: z
    .boolean()
    .describe("Whether the CLI login was removed from the server."),
});

const ok = (description: string, schema: z.ZodType) => ({
  description,
  content: { "application/json": { schema } },
});

export const antigravityPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/antigravity/status": {
    get: {
      tags: ["ai"],
      summary: "Get the Antigravity CLI status for the authenticated user",
      description:
        "Reports the CLI installation and the stored profile state. It never sets the connection to connected. Only the connection test does that.",
      responses: {
        "200": ok(
          "Antigravity CLI status",
          dataEnvelope(antigravityStatusResponse, "AntigravityStatusResponse"),
        ),
        ...stdResponses,
      },
    },
  },

  "/api/antigravity/auth/start": {
    post: {
      tags: ["ai"],
      summary: "Start interactive Antigravity CLI login",
      description:
        "Spawns `agy acp --login` on the host and captures the Google OAuth authorization URL for the user to complete in their browser.",
      responses: {
        "200": ok(
          "Authorization URL and profile ID",
          dataEnvelope(
            antigravityAuthStartResponse,
            "AntigravityAuthStartResponse",
          ),
        ),
        ...stdResponses,
      },
    },
  },

  "/api/antigravity/auth/submit": {
    post: {
      tags: ["ai"],
      summary: "Submit Google OAuth code for Antigravity login",
      description:
        "Sends the authorization code to the active CLI login session stdin, verifies tokens, and marks the profile as connected.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({ code: z.string().min(1) }),
          },
        },
      },
      responses: {
        "200": ok(
          "Authentication result",
          dataEnvelope(
            antigravityAuthSubmitResponse,
            "AntigravityAuthSubmitResponse",
          ),
        ),
        ...stdResponses,
      },
    },
  },

  "/api/antigravity/auth/cancel": {
    post: {
      tags: ["ai"],
      summary: "Cancel an active Antigravity CLI login session",
      description:
        "Terminates the spawned `agy acp --login` process and cleans up session state.",
      responses: {
        "200": ok(
          "Cancellation result",
          dataEnvelope(
            antigravityAuthCancelResponse,
            "AntigravityAuthCancelResponse",
          ),
        ),
        ...stdResponses,
      },
    },
  },

  "/api/antigravity/test": {
    post: {
      tags: ["ai"],
      summary: "Test the Antigravity profile connection",
      description:
        "Starts the CLI on the user's profile and opens a session. No prompt and no health data are sent. The result is stored and returned.",
      responses: {
        "200": ok(
          "Connection test result",
          dataEnvelope(antigravityTestResponse, "AntigravityTestResponse"),
        ),
        ...stdResponses,
      },
    },
  },

  "/api/antigravity/models": {
    get: {
      tags: ["ai"],
      summary: "List the models the Antigravity profile offers",
      description:
        "Starts the CLI on the user's profile and reads the model selector from the session. The list is never static. An empty list comes with a `reason`.",
      responses: {
        "200": ok(
          "Models and the selected model",
          dataEnvelope(antigravityModelsResponse, "AntigravityModelsResponse"),
        ),
        ...stdResponses,
      },
    },
  },

  "/api/antigravity/model": {
    patch: {
      tags: ["ai"],
      summary: "Choose the Antigravity model, or return to the CLI default",
      description:
        "Saves the model id, or clears it with `null`. Requires a profile set up by the connect flow (`auth/start`). A model the CLI does not offer fails the next completion with a clear error.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: antigravityModelPatchSchema },
        },
      },
      responses: {
        "200": ok(
          "The saved model",
          dataEnvelope(antigravityModelResponse, "AntigravityModelResponse"),
        ),
        ...stdResponses,
      },
    },
  },

  "/api/antigravity/disconnect": {
    post: {
      tags: ["ai"],
      summary: "Disconnect the Antigravity CLI provider",
      description:
        "Clears the profile ID and the stored state, and deletes the profile folder that holds the CLI login.",
      responses: {
        "200": ok(
          "Disconnect result",
          dataEnvelope(
            antigravityDisconnectResponse,
            "AntigravityDisconnectResponse",
          ),
        ),
        ...stdResponses,
      },
    },
  },

  "/api/antigravity/install": {
    post: {
      tags: ["ai"],
      summary: "Install or update Antigravity CLI binary on-demand",
      description:
        "Downloads and installs or updates the Antigravity CLI binary in the persistent profile directory. Administrators only: the binary is shared by every user on the server. Other users get 403. When updating, replaces an eligible HealthLog-managed binary atomically with the latest official release after checksum and version verification; externally managed binaries remain operator-managed. Administrators may pass force: true to force a reinstall or repair of a managed binary.",
      requestBody: {
        required: false,
        content: {
          "application/json": { schema: antigravityInstallSchema },
        },
      },
      responses: {
        "200": ok(
          "Installation result",
          dataEnvelope(
            antigravityInstallResponse,
            "AntigravityInstallResponse",
          ),
        ),
        ...stdResponses,
      },
    },
  },
};

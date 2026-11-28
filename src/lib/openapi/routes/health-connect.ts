/**
 * The Android Health Connect sync (v1.50.0, feature key
 * `health-connect.sync`): the web mints a pairing code, the app exchanges it
 * for a `health-connect:write` token, reads `state`, and posts batches.
 */
import type { ZodOpenApiObject } from "zod-openapi";

import {
  hcBatchRequestSchema,
  hcBatchResultSchema,
  hcPairRequestSchema,
  hcPairResultSchema,
  hcPairingResultSchema,
  hcStateResultSchema,
} from "@/lib/validations/health-connect-sync";

import {
  dataEnvelope,
  errorEnvelope,
  idempotencyKeyParameter,
  idempotentWrite,
  stdResponses,
} from "./shared";

const DEVICE_TOKEN =
  "Bearer with the scope `health-connect:write`, the token a paired Android device holds; a session or any other token is refused 403 `health-connect.device_token_required`. 401 `health-connect.device_unpaired` when the device was removed in Settings: the app stops and asks to reconnect, as for any 401.";

export const healthConnectPaths: ZodOpenApiObject["paths"] = {
  "/api/health-connect/pairing": {
    post: {
      tags: ["Integrations"],
      summary: "Mint a pairing code for an Android device",
      description:
        "Cookie session with a recent sign-in proof. Answers a one-time code (`hcp_` and 32 hex), valid for ten minutes and one exchange, and the deep link `healthlog-sync://pair?server=<origin>&code=<code>` the web shows as a QR code. Only the code's hash is stored. 403 `health-connect.pair.api_disabled` when the operator switched the API off.",
      responses: {
        "200": {
          description: "A fresh pairing code.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                hcPairingResultSchema,
                "HealthConnectPairingResponse",
              ),
            },
          },
        },
        "403": {
          description:
            "The API is switched off (`health-connect.pair.api_disabled`), or the session lacks a recent proof.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/health-connect/pair": {
    post: {
      tags: ["Integrations"],
      summary: "Exchange a pairing code for a device token",
      description:
        "No credential: the one-time code in the body is the credential, never in the URL. Answers a token with the single scope `health-connect:write`, valid 365 days and extended a year by any accepted batch once fewer than 30 days are left, and the id of the `Device` row it is bound to. Pairing the same `installId` again revokes the token it held before. Limited per IP; a 429 carries `Retry-After`.",
      security: [],
      requestBody: {
        required: true,
        content: { "application/json": { schema: hcPairRequestSchema } },
      },
      responses: {
        "200": {
          description: "Paired.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                hcPairResultSchema,
                "HealthConnectPairResponse",
              ),
            },
          },
        },
        ...stdResponses,
        "401": {
          description:
            "`health-connect.pair.code_invalid`: the code is unknown, expired or used, one answer for all three. Show a new code.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "403": {
          description:
            "`health-connect.pair.api_disabled`: the operator switched the API off.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "`health-connect.pair.install_taken`: this `installId` is paired with another account. The app makes a new install id and pairs again; the code stays valid.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "422": {
          description: "`health-connect.pair.invalid`: a malformed body.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/health-connect/state": {
    get: {
      tags: ["Integrations"],
      summary: "Sync state for a paired Android device",
      description: `The types and aggregates the server takes, the apps whose data arrives through a direct integration, the instant before which heart rate is sent hourly, the newest reading held per record type, and the limits of a batch. The change tokens stay on the phone; this is no cursor. ${DEVICE_TOKEN}`,
      responses: {
        "200": {
          description: "The state.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                hcStateResultSchema,
                "HealthConnectStateResponse",
              ),
            },
          },
        },
        "403": {
          description:
            "`health-connect.device_token_required`, or `auth.scope.insufficient` for a token without the scope.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/health-connect/batch": {
    post: {
      parameters: [{ ...idempotencyKeyParameter, required: true }],
      tags: ["Integrations"],
      summary: "Post one batch of Health Connect records",
      description: `Records (spot readings with the export's column names and units, heart-rate series, sleep and exercise sessions), day totals and hourly heart rate, and deletes by record id. Written as source \`HEALTH_CONNECT\` with the export import's own mapping and rules, so a record lands on the row an export of it writes. One result per item; neither \`rejected\` nor a skip should hold a change token back, only a non-2xx answer does. The \`Idempotency-Key\` is required here (400 \`health-connect.batch.idempotency_key_required\` without it). A 429 from the account's bucket or the ingest admission carries \`Retry-After\`; resend the same batch with the same key after it. ${DEVICE_TOKEN}`,
      requestBody: {
        required: true,
        content: { "application/json": { schema: hcBatchRequestSchema } },
      },
      responses: {
        ...idempotentWrite(),
        "200": {
          description: "Batch processed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                hcBatchResultSchema,
                "HealthConnectBatchResponse",
              ),
            },
          },
        },
        "400": {
          description:
            "`health-connect.batch.idempotency_key_required`: no usable `Idempotency-Key`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "403": {
          description:
            "`health-connect.device_token_required`, or `auth.scope.insufficient` for a token without the scope.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "The body exceeds 4 MiB.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "`health-connect.batch.too_large`: more than 500 items or 5,000 heart-rate samples. `health-connect.batch.invalid`: the envelope is malformed (a malformed single item is answered `rejected` at its index instead). Nothing was written.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
};

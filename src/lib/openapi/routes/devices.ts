/**
 * OpenAPI route table — device (APNs) registration.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { isoDateTime } from "@/lib/validations/datetime";
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import {
  dataEnvelope,
  deviceRevokeResponse,
  errorEnvelope,
  stdResponses,
} from "./shared";
import {
  devicePushBlockSchema,
  devicePushRequestFields,
  liveActivityStatementFields,
} from "./push-relay";

const deviceRegisterRequest = z
  .object({
    token: z
      .string()
      .min(8)
      .max(512)
      .regex(/^[A-Za-z0-9+/=._:-]+$/)
      .describe("Generic device identifier (legacy; APNs token below)."),
    bundleId: z.string().min(1).max(128),
    locale: z.string().min(2).max(16).optional(),
    appVersion: z.string().min(1).max(32).optional(),
    model: z.string().min(1).max(64).optional(),
    apnsToken: z
      .string()
      .min(8)
      .max(256)
      .regex(/^[A-Fa-f0-9]+$/)
      .optional()
      .describe(
        "Hex-encoded APNs device token. Must be paired with `apnsEnvironment`.",
      ),
    apnsEnvironment: z
      .enum(["sandbox", "production"])
      .optional()
      .describe(
        "Gateway the iOS client received `apnsToken` from. Server never auto-detects.",
      ),
    medicationDelivery: z
      .enum(["server", "client"])
      .nullable()
      .optional()
      .describe(
        'v1.7.0 per-device medication-delivery override; omitted keeps the stored value. "client" keeps the server\'s medication-reminder push off this device (the app reminds locally), "server" pushes it to this device whatever the account says, and null / no override follows the account-wide switch (`notificationPrefs.medication.clientManaged` or `deliveryDefault: "client"`). Since v1.48.0 the server honours it per device on the APNs send; before, it was stored and echoed only. Only the reminder that announces a dose is affected: follow-ups for a dose still open, every other push, and the Telegram, ntfy, webhook, email and Web Push channels are not.',
      ),
    liveActivityPushToken: z
      .string()
      .min(8)
      .max(256)
      .regex(/^[A-Fa-f0-9]+$/)
      .nullable()
      .optional()
      .describe(
        "v1.17.1 (#22) hex-encoded ActivityKit Live Activity push token (distinct from the device APNs token). The server addresses a Live Activity update / end push on a medication-intake mutation. Omitted = keep the prior value; null = clear it when the Activity ends.",
      ),
    liveActivityTokens: z
      .array(
        z.object({
          token: z
            .string()
            .min(8)
            .max(256)
            .regex(/^[A-Fa-f0-9]+$/)
            .describe("The Activity's ActivityKit push token (hex)."),
          medicationId: z
            .string()
            .optional()
            .describe(
              "The medication the Activity shows. Required unless `relayStart` is true.",
            ),
          relayStart: z
            .boolean()
            .optional()
            .describe(
              "The Activity was started by the server over the relay (attributes type `HealthLogDoseAttributes`), so the app does not know its dose: the server fills in `medicationId` and `slotInstant` of the dose it started. Send its update token with an `hl-activity-v1` statement as for any Activity.",
            ),
          slotInstant: isoDateTime()
            .optional()
            .describe(
              "The slot the Activity counts down to (the today row's `slotInstant`). With it the server ends this Activity once that slot is taken or skipped; without it, once no dose of the medication the Activity could show is open.",
            ),
          ...liveActivityStatementFields,
        }),
      )
      .max(8)
      .optional()
      .describe(
        "The device's running medication Live Activities, as a full replacement list: present replaces the stored list (an empty array clears it), omitted leaves it unchanged. Each entry is ended with one `end` push once its dose is answered, and removed after the push. When this field is present the legacy `liveActivityPushToken` is ignored.",
      ),
    ...devicePushRequestFields,
  })
  .meta({
    id: "DeviceRegisterRequest",
    description:
      "Native device registration. Re-registering an APNs token belonging to another user returns 409 (cross-user-hijack guard).",
  });

export const devicePaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/devices": {
    post: {
      tags: ["Devices"],
      summary: "Register native device + APNs token",
      description:
        "Idempotent upsert by `token`. APNs token + environment are paired — supplying one without the other returns 422. Cross-user re-registration of either identifier returns 409. A refused push field (push key, relay binding, consent) returns 422 with `meta.errorCode` `devices.push.<reason>` and changes nothing; more than 10 new relay bindings for one account in 24 hours return 429 `devices.push.relay_daily_limit`. When the device's APNs token changes, the old token's relay binding is removed and the device has to bind the new token (`relayState: rebind_needed` unless the request carries the new `relayBinding`). The answer's `push` block is the device's push state after the call.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: deviceRegisterRequest } },
      },
      responses: {
        "201": {
          description: "Device registered or refreshed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ id: z.string(), push: devicePushBlockSchema }),
                "DeviceRegisterResponse",
              ),
            },
          },
        },
        "409": {
          description:
            "Device or APNs token already registered to another user.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/devices/{id}": {
    delete: {
      tags: ["Devices"],
      summary: "Revoke a device and everything bound to it",
      description:
        "Deletes the device and, in one transaction, revokes every refresh and access token bound to it — the cleanup a native client runs when it rotates its own registration. The counts come back so the caller can log what the cascade actually killed. Scoped to the caller's own devices: an id belonging to somebody else is indistinguishable from one that does not exist. This is a second URL for `DELETE /api/auth/me/devices/{id}`; the two share one transactional helper and behave identically, and the duplication exists so the native rotation loop has a path that is not the settings-surface one. Auth via cookie or Bearer.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Device id.",
        },
      ],
      responses: {
        "200": {
          description: "The device and its tokens were revoked.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                deviceRevokeResponse,
                "DeviceRevokeEnvelope",
              ),
            },
          },
        },
        "404": {
          description:
            "No such device for this caller — also the answer for one already revoked, so a retry after a successful revoke is a 404 rather than an idempotent 200.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
};

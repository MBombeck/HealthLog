/**
 * OpenAPI route table — the push relay: the `push` block of the account
 * payload, the push fields and answer of `POST /api/devices`, the envelope
 * receipts on `GET /api/sync/state`, and the operator's admin switch.
 *
 * The request schemas are the runtime ones
 * (`src/lib/push-relay/device-registration.ts`), so the wire contract stays
 * single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import {
  activityStatementSchema,
  pushKeySchema,
  relayBindingSchema,
  relayConsentSchema,
} from "@/lib/push-relay/device-registration";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

const senderKey = z
  .object({
    publicKey: z
      .string()
      .describe("X25519 sender public key, 32 bytes, unpadded base64url."),
    status: z.enum(["current", "previous"]),
  })
  .meta({ id: "PushSenderKey" });

export const relayCapabilityBlock = z
  .object({
    available: z
      .boolean()
      .describe(
        "This server can use a relay at all (`PUSH_RELAY_MODE` is not `off` and the relay's identity keys are pinned).",
      ),
    offered: z
      .boolean()
      .describe(
        "The operator turned the relay on. Show the opt-in card only when this is true and `push.device.consent` is false; when it turns false, revoke the binding at the relay directly and return to local reminders.",
      ),
    state: z
      .enum(["ok", "degraded", "down", "off"])
      .describe(
        "The relay's health as this server sees it; `off` while not offered.",
      ),
    since: z
      .string()
      .nullable()
      .describe("When `state` last changed, ISO 8601."),
    reason: z
      .string()
      .nullable()
      .describe("A short code for a non-`ok` state."),
    instanceId: z
      .string()
      .nullable()
      .describe(
        "The instance id the relay issued: what `hl-bind-v1` and `hl-activity-v1` are signed for. Null until registered.",
      ),
    senderKeys: z
      .array(senderKey)
      .describe(
        "The keys to pin for this account: `current`, and `previous` for 30 days after a rotation. Present whenever this server seals envelopes, over the relay or over its own APNs key; a sealed push opens with one of them.",
      ),
    envelopeVersions: z
      .array(z.number().int())
      .describe(
        "Envelope versions this server seals (`[1]`). Non-empty means the device must refuse unsealed content.",
      ),
    liveActivity: z
      .array(z.string())
      .describe('Live Activity events the relay carries (`["end"]`).'),
    termsUrl: z.string().nullable(),
    privacyUrl: z.string().nullable(),
    consentTextVersion: z
      .string()
      .describe(
        "The consent text version the card shows; sent back as `relayConsent.textVersion`.",
      ),
  })
  .meta({ id: "PushRelayCapability" });

export const devicePushBlockSchema = z
  .object({
    transport: z
      .enum(["relay", "direct", "none"])
      .describe(
        "How pushes reach this device: this server's own APNs key, the relay, or not at all.",
      ),
    envelope: z
      .number()
      .int()
      .nullable()
      .describe(
        "The envelope version sealed to this device, or null when it gets none.",
      ),
    consent: z
      .boolean()
      .describe("The person turned the relay on for this device."),
    relayState: z
      .enum(["none", "bound", "rebind_needed", "conflict"])
      .describe(
        "`rebind_needed`: send a fresh `relayBinding`. `conflict`: answer the relay's challenge push directly.",
      ),
    intakeSync: z
      .enum(["ok", "degraded"])
      .describe(
        "`degraded` when the relay is not healthy, the last dose confirmation to this device was dropped, or a push the relay accepted was never opened.",
      ),
    senderKeys: z.array(senderKey),
    relayInstanceId: z.string().nullable(),
  })
  .meta({ id: "DevicePushState" });

/** The `push` block of `GET /api/auth/me`. */
export const accountPushBlock = z
  .object({
    relay: relayCapabilityBlock,
    device: devicePushBlockSchema
      .nullable()
      .describe(
        "The calling device, named by `X-Device-Id`; null when the header names none of the caller's devices.",
      ),
  })
  .describe(
    "v1.49 — the push relay and the calling device's push state. Clients gate on these fields, never on a version.",
  );

/** The push fields merged into `DeviceRegisterRequest`. */
export const devicePushRequestFields = {
  pushKey: pushKeySchema
    .nullable()
    .optional()
    .describe(
      "The device's X25519 push key with the envelope suites it opens. Every later push to the device is sealed to it. A low-order key is refused with 422 `devices.push.invalid_push_key`. `null` withdraws it and the relay binding.",
    ),
  relayBinding: relayBindingSchema
    .optional()
    .describe(
      "The signed `hl-bind-v1` statement, forwarded to the relay unchanged. Accepted only with `relayConsent.granted: true` and a push key; refused with 422 `devices.push.<reason>` when the instance id, the token tag or the signature does not hold.",
    ),
  relayConsent: relayConsentSchema
    .optional()
    .describe(
      "The person's choice on the opt-in card. `granted: false` withdraws the consent: the binding is removed at the relay.",
    ),
};

/** The signed statement fields of one `liveActivityTokens` entry. */
export const liveActivityStatementFields = {
  statement: activityStatementSchema
    .optional()
    .describe(
      "The `hl-activity-v1` statement for this Activity, signed with the binding key. Stored here and handed to the relay only inside the end push.",
    ),
  signature: z
    .string()
    .optional()
    .describe("Ed25519 signature of the statement, unpadded base64url."),
};

const adminRelayStatus = z
  .object({
    allowed: z.boolean(),
    available: z.boolean(),
    unavailableReason: z
      .enum(["mode_off", "invalid_url", "keys_unpinned"])
      .nullable(),
    relayHost: z.string().nullable(),
    offered: z.boolean(),
    state: z.enum(["ok", "degraded", "down", "off"]),
    since: z.string().nullable(),
    reason: z.string().nullable(),
    instanceId: z.string().nullable(),
    tier: z.string().nullable(),
    notice: z
      .object({ id: z.string(), level: z.string().nullable() })
      .nullable(),
    lastSuccessAt: z.string().nullable(),
    devices: z.object({ bound: z.number().int(), consented: z.number().int() }),
    termsVersion: z.string(),
    termsUrl: z.string().nullable(),
    privacyUrl: z.string().nullable(),
    docsUrl: z.string(),
    noticePending: z.boolean(),
  })
  .meta({ id: "AdminPushRelayStatus" });

export const pushRelayAdminPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/admin/push-relay": {
    get: {
      tags: ["Admin"],
      summary: "Push relay state for the admin switch",
      description: "Admin-only, cookie-only.",
      responses: {
        "200": {
          description: "The relay state.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                adminRelayStatus,
                "AdminPushRelayStatusEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Admin"],
      summary: "Offer the push relay to this server's users, or stop",
      description:
        "Turning it on needs `acceptTerms` and `householdOnly`, registers the instance at the relay and creates its key. Turning it off deletes the instance at the relay, every device binding with it, and the key. Admin-only, cookie-only, audit-logged.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: z
              .object({
                enabled: z.boolean(),
                acceptTerms: z.boolean().optional(),
                householdOnly: z.boolean().optional(),
              })
              .meta({ id: "AdminPushRelaySwitch" }),
          },
        },
      },
      responses: {
        "200": {
          description: "The new relay state.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                adminRelayStatus,
                "AdminPushRelaySwitchEnvelope",
              ),
            },
          },
        },
        "409": {
          description: "The relay is not available on this server.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/admin/push-relay/notice": {
    post: {
      tags: ["Admin"],
      summary: "Dismiss the one-time push relay notice",
      description:
        "For the calling admin account; it does not come back. Admin-only, cookie-only.",
      responses: {
        "200": {
          description: "Dismissed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ dismissed: z.literal(true) }),
                "AdminPushRelayNoticeEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};

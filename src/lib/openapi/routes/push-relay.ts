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
  liveActivityConsentSchema,
  liveActivityStartSchema,
  liveActivityWithdrawSchema,
  relayConsentSchema,
} from "@/lib/push-relay/device-registration";
import { relayInviteSchema } from "@/lib/push-relay/invite";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";
import { isoDateTime } from "@/lib/validations/datetime";

const senderKey = z
  .object({
    publicKey: z
      .string()
      .describe("X25519 sender public key, 32 bytes, unpadded base64url."),
    status: z
      .enum(["next", "current", "previous"])
      .describe(
        "`current` seals every envelope now. `next` is the incoming key: published at least 7 days before it seals anything, then it becomes `current` and the old `current` becomes `previous`. `previous` sealed until its retirement and stays published for 30 days after it. Pin every listed key and try each when opening.",
      ),
  })
  .meta({ id: "PushSenderKey" });

export const relayCapabilityBlock = z
  .object({
    host: z
      .string()
      .nullable()
      .describe(
        "The relay host, lower case, without scheme or port: the `host` field of every statement the app signs (`hl-bind-v1`, `hl-activity-v1`) and of the relay's response signatures.",
      ),
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
        "The keys to pin for this account, at most three: `next` (announced at least 7 days before it seals anything), `current`, and `previous` for 30 days after it retired. Pin all of them and try each. The server enforces the notice: sealing switches only to a key that was published as `next` for 7 days, and a new `next` is announced only after `previous` retired. The one exception is the operator's emergency rotation of an exposed key, which replaces `current` at once and drops `next` and `previous`. Present whenever this server seals envelopes, over the relay or over its own APNs key.",
      ),
    envelopeVersions: z
      .array(z.number().int())
      .describe(
        "Envelope versions this server seals (`[1]`). Non-empty means the device must refuse unsealed content.",
      ),
    liveActivity: z
      .array(z.string())
      .describe(
        'Live Activity events the relay carries: `["end"]`, and `["end", "start", "update"]` while the operator\'s switch (`PUSH_RELAY_LIVE_ACTIVITY=on`) is on; start and update reach only a device with `push.device.liveActivityConsent`. Empty while the relay is not offered. Offer the second switch only when it lists `start`.',
      ),
    liveActivityConsentTextVersion: z
      .string()
      .describe(
        "The text version of the Live Activity consent sentence; sent back as `liveActivityConsent.textVersion`.",
      ),
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
    senderKeys: z
      .array(senderKey)
      .describe("The same keys as `push.relay.senderKeys`."),
    relayInstanceId: z.string().nullable(),
    liveActivityConsent: z
      .boolean()
      .describe(
        "The relay holds the device's Live Activity consent: start and update over the relay. Withdrawn with the relay consent.",
      ),
    liveActivityStarted: z
      .object({
        medicationId: z.string(),
        slotInstant: isoDateTime(),
      })
      .nullable()
      .describe(
        "The dose the Live Activity the server started on this device (over the relay) shows. The start push never carries it, so the app reads it here, and in the `POST /api/devices` answer right after it registers the started Activity's token (`relayStart: true`). Null when no server start is pending or running, or once that slot is taken, skipped or missed, its medication paused, ended or deleted, or the Activity ended.",
      ),
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
      "The person's choice on the opt-in card. `granted: false` withdraws the consent: the binding is removed at the relay, and the Live Activity consent with it.",
    ),
  liveActivityConsent: liveActivityConsentSchema
    .optional()
    .describe(
      'The second, separate switch: Live Activity start and update over the relay, off by default ("The relay and Apple can see when a dose is due."). The device\'s `hl-la-consent-v1` (`textVersion`, `iat` within 300 s, signature by the binding key), checked here and passed on to the relay at once; `push.device.liveActivityConsent` turns true once the relay took it. Needs a device bound with the relay consent, else 422 `devices.push.relay_consent_required`; a bad statement 422 `devices.push.bad_signature` or `devices.push.statement_stale`.',
    ),
  liveActivityWithdraw: liveActivityWithdrawSchema
    .optional()
    .describe(
      "The device's `hl-la-withdraw-v1` (`iat` within 300 s, signature by the binding key): drops the Live Activity consent here and at the relay. Withdrawing the relay consent drops it too.",
    ),
  liveActivityStart: liveActivityStartSchema
    .nullable()
    .optional()
    .describe(
      "The ActivityKit push-to-start token with the device's `hl-la-start-v1` (`statement.laTokenTag` is the tag of the push-to-start token, `iat` at most 30 days old; sign again when the token changes and at least every 30 days). Handed to the relay only inside a start push. `null` drops it.",
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
    usage: z
      .object({
        windowDays: z.number().int(),
        accepted: z.number().int(),
        pending: z.number().int(),
        dropped: z.number().int(),
        failed: z.number().int(),
        lastFailure: z
          .object({ reason: z.string().nullable(), at: z.string() })
          .nullable(),
      })
      .describe(
        "What this instance handed the relay in the last `windowDays` days, from its own delivery ledger: counts per outcome and the last failure. Aggregate only.",
      ),
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
        "Turning it on needs `acceptTerms` and `householdOnly`, registers the instance at the relay and creates its key; `invite` carries the relay's one-time code when the relay is invite-only. The answer is the state after the registration attempt: a refusal reads `offered: true`, `instanceId: null` and a `reason` (`invite_required`, `invite_rejected`, `registration_paused`, or a transport code). Turning it off deletes the instance at the relay, every device binding with it, and the key. Admin-only, cookie-only, audit-logged.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: z
              .object({
                enabled: z.boolean(),
                acceptTerms: z.boolean().optional(),
                householdOnly: z.boolean().optional(),
                invite: relayInviteSchema
                  .optional()
                  .describe(
                    "The relay's one-time invite code, 24 base64url characters, for a relay that accepts new servers by invitation only. Used for this registration attempt only and never stored; any other shape is 422.",
                  ),
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
  "/api/admin/push-relay/test": {
    post: {
      tags: ["Admin"],
      summary: "Send a test push through the relay to the admin's own devices",
      description:
        "One harmless sealed alert (`RELAY_TEST`) to each relay-bound device of the calling admin, with the relay's signed answer and the delivery state per device. Admin-only, cookie-only, 5 per 15 minutes.",
      responses: {
        "200": {
          description: "What the relay answered.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z
                  .object({
                    outcome: z.enum([
                      "accepted",
                      "failed",
                      "waiting",
                      "no_device",
                    ]),
                    results: z.array(
                      z.object({
                        deviceId: z.string(),
                        model: z.string().nullable(),
                        relayStatus: z
                          .number()
                          .int()
                          .describe(
                            "The item status the relay signed; 0 when no signed answer arrived.",
                          ),
                        relayResult: z.string(),
                        relayReason: z.string().nullable(),
                        delivery: z.string(),
                      }),
                    ),
                  })
                  .meta({ id: "AdminPushRelayTest" }),
                "AdminPushRelayTestEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/admin/push-relay/rotate-key": {
    post: {
      tags: ["Admin"],
      summary: "Rotate the instance signing key at the relay now",
      description:
        "Outside the 30-day schedule. The relay allows one rotation per UTC day. Admin-only, cookie-only, audit-logged.",
      responses: {
        "200": {
          description: "The rotation's outcome.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  outcome: z.enum([
                    "rotated",
                    "refused",
                    "unreachable",
                    "not_registered",
                  ]),
                }),
                "AdminPushRelayRotateEnvelope",
              ),
            },
          },
        },
        "409": {
          description: "The relay is not registered on this server.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/admin/push-relay/rotate-sender-key": {
    post: {
      tags: ["Admin"],
      summary: "Emergency rotation of the envelope sender key",
      description:
        "For a sender key known to be exposed: a new current key at once, without the 7-day announcement, and the previous key dropped. Devices that have not fetched the new key show the neutral placeholder until the app is opened. Admin-only, cookie-only, fresh second factor, audit-logged.",
      responses: {
        "200": {
          description: "Rotated.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ rotated: z.literal(true) }),
                "AdminPushRelaySenderRotateEnvelope",
              ),
            },
          },
        },
        "409": {
          description: "This server seals no envelopes yet.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
};

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
import { RELAY_OPERATOR_DECISIONS } from "@/lib/push-relay/operator-decision";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";
import { isoDateTime } from "@/lib/validations/datetime";

const operatorDecisionSchema = z
  .enum(RELAY_OPERATOR_DECISIONS)
  .meta({ id: "PushRelayOperatorDecision" });

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
    operatorDecision: operatorDecisionSchema.describe(
      'The operator\'s one answer, for the whole server, to "Send push notifications through the HealthLog relay?". `on` once the registration at the relay succeeded; `off` when an admin said no or switched the relay off, and also when there is nothing to decide (`available: false`, or the server has an APNs key of its own, which the relay would never be used beside); `undecided` otherwise. Ask each person about the relay only while it is `on`.',
    ),
    canDecide: z
      .boolean()
      .describe(
        "The caller is an admin of a server whose relay is available (never on a demo deploy). Informational for a Bearer client: the answer is given on the web admin page (`/admin`), because the routes that give it (`POST /api/admin/push-relay/decision`, `PUT /api/admin/push-relay`) are cookie-only like every admin route and refuse a Bearer token.",
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
        "`rebind_needed`: send a fresh `relayBinding`. `conflict`: answer the relay's challenge push directly. A `conflict` not settled by a fresh binding within 30 minutes (the challenge's lifetime) reads `rebind_needed` (v1.49.0).",
      ),
    intakeSync: z
      .enum(["ok", "degraded"])
      .describe(
        "`degraded` when the relay is not healthy, the last dose confirmation to this device was dropped and no alert opened since, or the newest alert the relay accepted was never opened although the device reported receipts well after it. Only the last 24 hours count; silent and Live Activity pushes never do, since iOS delivers them at its discretion (v1.49.0). The reason is in the device's push diagnostics.",
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
        "The dose the Live Activity the server started on this device (over the relay) shows. The start push never carries it, so the app reads it here, and in the `POST /api/devices` answer right after it registers the started Activity's token (`relayStart: true`). Null until the relay accepted the start (a start still in flight or one the relay refused shows null; a refused one is tried again later), when no server start is running, or once that slot is taken, skipped or missed, its medication paused, ended or deleted, or the Activity ended.",
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
    reason: z
      .string()
      .nullable()
      .describe(
        "Why the state is not `ok`, e.g. `bad_signature` (the relay refused this server's signature three times in a row), `relay_degraded`, `relay_maintenance` or `relay_misconfigured` (what the relay's status reports about itself), `circuit_open`, or a registration refusal.",
      ),
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
    handoff: z
      .object({
        windowHours: z.number().int(),
        count: z
          .number()
          .int()
          .describe(
            "Pushes the relay answered `accepted` in the window: what the percentiles are computed over.",
          ),
        p50Ms: z
          .number()
          .int()
          .nullable()
          .describe(
            "The median hand-off time in whole milliseconds; null when `count` is 0.",
          ),
        p95Ms: z
          .number()
          .int()
          .nullable()
          .describe(
            "The 95th percentile of the hand-off time in whole milliseconds; null when `count` is 0.",
          ),
        retried: z
          .number()
          .int()
          .describe(
            "How many of the `count` pushes waited for at least one retry on this server, so their time includes its backoff.",
          ),
      })
      .describe(
        "v1.49.0. The hand-off time as this server sees it, over the pushes the relay accepted in the last `windowHours` hours: from queueing a push on this server until the relay answered `accepted`. The relay answers `accepted` only once Apple accepted the push, so the time covers this server's hand-off, the network and the relay's request to Apple. From this instance's own delivery ledger. Aggregate only: nothing per person, device or kind of push.",
      ),
    relayCheck: z
      .object({
        checkedAt: isoDateTime()
          .nullable()
          .describe("When this server last asked `GET /v1/status`."),
        answeredAt: isoDateTime()
          .nullable()
          .describe("When the relay last answered it."),
        state: z
          .enum(["ok", "degraded", "maintenance", "misconfigured"])
          .nullable()
          .describe("The relay's own state in that answer."),
        devices: z
          .object({
            active: z.number().int(),
            provisional: z.number().int(),
            limit: z.number().int(),
          })
          .nullable()
          .describe(
            "This instance's bindings at the relay: active (soft-invalid included), provisional, and its device limit.",
          ),
      })
      .nullable()
      .describe(
        "v1.49.0. The hourly signed `GET /v1/status`: what the relay last reported about itself and this instance. Null before the first check.",
      ),
    termsVersion: z.string(),
    termsConfirmationNeeded: z
      .boolean()
      .describe(
        "The relay is on, and the terms text the operator accepted is older than `termsVersion`. The relay keeps running; turning it on again with both confirmations records the current text.",
      ),
    unbindsPending: z
      .number()
      .int()
      .describe(
        "Device unbinds owed to the relay that it has not confirmed yet.",
      ),
    unreachableRegistrations: z
      .array(z.string())
      .describe(
        "Relay hosts this server is still registered with but cannot reach under its current settings (`PUSH_RELAY_MODE=off`, a changed `PUSH_RELAY_URL`); they keep its device bindings until it leaves them.",
      ),
    termsUrl: z.string().nullable(),
    privacyUrl: z.string().nullable(),
    docsUrl: z.string(),
    operatorDecision: operatorDecisionSchema.describe(
      "As `push.relay.operatorDecision` of `/api/auth/me`: the relay question is open while it is `undecided`.",
    ),
  })
  .meta({ id: "AdminPushRelayStatus" });

const adminRelaySwitchBody = z
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
  .meta({ id: "AdminPushRelaySwitch" });

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
        "Turning it on needs `acceptTerms` and `householdOnly`, registers the instance at the relay and creates its key; `invite` carries the relay's one-time code when the relay is invite-only. The answer is the state after the registration attempt: a refusal reads `offered: true`, `instanceId: null` and a `reason` (`invite_required`, `invite_rejected`, `registration_paused`, or a transport code). `operatorDecision` becomes `on` once the registration succeeded. Turning it off deletes the instance at the relay, every device binding with it, and the key, and sets `operatorDecision` to `off`. On a relay that is on and registered, turning it on again records the operator's acceptance of the current terms text and changes nothing else. Admin-only, cookie-only, audit-logged, 10 per 15 minutes (429 `admin.pushRelay.rateLimited`).",
      requestBody: {
        required: true,
        content: { "application/json": { schema: adminRelaySwitchBody } },
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
  "/api/admin/push-relay/decision": {
    post: {
      tags: ["Admin"],
      summary: "Answer the relay question for the whole server",
      description:
        "The admin's answer to \"Send push notifications through the HealthLog relay?\", only while `operatorDecision` is `undecided` (409 `admin.pushRelay.decisionNotOpen` otherwise; the switch under `PUT /api/admin/push-relay` changes it later). `enabled: false` sets `off`, and nobody is asked again; an unfinished registration goes with it. `enabled: true` takes the switch's confirmations and invite code and turns the relay on through the same path; `operatorDecision` becomes `on` only once the registration succeeded, and a refusal leaves the question open with its `reason`. Admin-only and cookie-only: a Bearer token never reaches it, so a native client opens the web admin page (`/admin`) instead. Audit-logged (`admin.push_relay.declined`, `admin.push_relay.enabled`), rate limited with the switch (10 per 15 minutes, 429 `admin.pushRelay.rateLimited`).",
      requestBody: {
        required: true,
        content: { "application/json": { schema: adminRelaySwitchBody } },
      },
      responses: {
        "200": {
          description: "The relay state after the answer.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                adminRelayStatus,
                "AdminPushRelayDecisionEnvelope",
              ),
            },
          },
        },
        "409": {
          description:
            "The question is not open (`admin.pushRelay.decisionNotOpen`), or the relay is not available on this server (`admin.pushRelay.unavailable`).",
          content: { "application/json": { schema: errorEnvelope } },
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
                    outcome: z
                      .enum(["accepted", "failed", "waiting", "no_device"])
                      .describe(
                        "`accepted` only when the relay accepted the push to every device; `failed` when one failed for good; `waiting` when the rest waits for a retry. Per device in `results`.",
                      ),
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
        "Outside the 30-day schedule. The relay allows one rotation per UTC day. Admin-only, cookie-only, audit-logged, 5 per hour (429 `admin.pushRelay.rateLimited`).",
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
        "For a sender key known to be exposed: a new current key at once, without the 7-day announcement, and the previous key dropped. Devices that have not fetched the new key show the neutral placeholder until the app is opened. Admin-only, cookie-only, audit-logged, 5 per hour (429 `admin.pushRelay.rateLimited`). Needs a fresh proof: a second factor confirmed in the last five minutes on an admin who has one, otherwise a password re-entry, a passkey or a sign-in in the same window (401 `auth.reproof.required` with `meta.methods`).",
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

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
import { APNS_TOKEN_MAX_HEX } from "@/lib/push-relay/device-registration";

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
      .max(APNS_TOKEN_MAX_HEX)
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
        'v1.7.0 per-device medication-delivery override; omitted keeps the stored value. "client" keeps the server\'s medication-reminder push off this device (the app reminds locally) while its local plan can run (see `localRunwayUntil`; without one, for 3 days after its last authenticated request), "server" pushes it to this device whatever the account says, and null / no override follows the account-wide switch (`notificationPrefs.medication.clientManaged` or `deliveryDefault: "client"`). Since v1.48.0 the server honours it per device on the APNs send; before, it was stored and echoed only. Since v1.49.0 the relay follows the same decision as this server\'s own APNs key. Only the reminder that announces a dose is affected: follow-ups for a dose still open (except over the relay, which carries them only to a device the server reminds), every other push, and the Telegram, ntfy, webhook, email and Web Push channels are not. `GET /api/devices/me/push-diagnostics` shows the resolved value as `medicationReminder`.',
      ),
    localRunwayUntil: isoDateTime()
      .nullable()
      .optional()
      .describe(
        "Until when this device has its medication reminders planned locally (ISO 8601). Only read while the device delivers locally (`medicationDelivery: \"client\"`, or inheriting a client-managed account). Such a device keeps the server's reminder push off only while `now <= localRunwayUntil`; past it the server pushes the reminder that announces a dose to this device again. Without a runway the server allows 3 days after the device's last authenticated request. Must lie between now (5 minutes of clock skew allowed) and 14 days ahead, else 422. Null clears it (back to the 3-day rule); omitted keeps the stored value. Send it on every registration, since a request that does not register does not move it.",
      ),
    liveActivityPushToken: z
      .string()
      .min(8)
      .max(APNS_TOKEN_MAX_HEX)
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
            .max(APNS_TOKEN_MAX_HEX)
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
              "The Activity was started by the server over the relay (attributes type `HealthLogDoseAttributes`), so the app does not know its dose: the server fills in `medicationId` and `slotInstant` of the dose it started. Send its update token with an `hl-activity-v1` statement as for any Activity. Only Activities registered with it get relay updates; one the app started itself gets the direct path and the end push only. The mark sticks to the token on later posts of the set; a rotated token is sent with it again.",
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
        "The device's running medication Live Activities, as a full replacement list: present replaces the stored list (an empty array clears it), omitted leaves it unchanged. An entry in a shape the server does not take is left out of the list and named in the answer's `ignored` (`liveActivityTokens[<index>]`); a list longer than 8 is left out whole. Each entry is ended with one `end` push once its dose is answered, and removed after the push. When this field is present the legacy `liveActivityPushToken` is ignored.",
      ),
    ...devicePushRequestFields,
  })
  .meta({
    id: "DeviceRegisterRequest",
    description:
      "Native device registration. A `token` or `apnsToken` another account holds is taken over once that account is signed out of the device, and refused with 409 while it is still signed in there (see `POST /api/devices`).",
  });

const lastDelivery = z
  .object({
    at: isoDateTime().describe("When the push was handed on."),
    eventType: z
      .string()
      .describe("The push type, e.g. `MEDICATION_REMINDER`, `DATA_CHANGED`."),
    outcome: z
      .enum([
        "pending",
        "accepted",
        "opened",
        "dropped",
        "failed",
        "sent",
        "skipped",
      ])
      .describe(
        "Over the relay: `pending` (waiting or retrying), `accepted` (the relay took it), `opened` (accepted and covered by a receipt from this device), `dropped` or `failed`. Over this server's own APNs key: `sent` for a silent push, `accepted`, `failed` or `skipped` for an alert.",
      ),
    reason: z
      .string()
      .nullable()
      .describe(
        "The relay's or Apple's reason on a failure; for a `pending` push over the relay, the code it waits on (`bad_signature`, `relay_unavailable`, `relay_paused`, a quota code); else null.",
      ),
  })
  .nullable();

const devicePushDiagnostics = z
  .object({
    deviceId: z.string(),
    transport: z
      .enum(["relay", "direct", "none"])
      .describe(
        "The route the send takes, by the same rule as `push.device.transport`: this server's own APNs key (`direct`), the relay, or none.",
      ),
    sealed: z
      .boolean()
      .describe(
        "Pushes to this device are sealed envelopes. False for a device without a push key, which gets plaintext pushes over this server's own key, or none.",
      ),
    apnsToken: z
      .object({
        prefix: z.string().nullable(),
        suffix: z.string().nullable(),
      })
      .nullable()
      .describe(
        "The APNs token masked: its first and last 8 hex characters only, the same mask as the admin diagnostic. Null when the device registered no APNs token.",
      ),
    apnsEnvironment: z.enum(["sandbox", "production"]).nullable(),
    relay: z
      .object({
        state: z.enum(["ok", "degraded", "down", "off"]),
        since: isoDateTime().nullable(),
        reason: z
          .string()
          .nullable()
          .describe(
            "As `push.relay.reason`, e.g. `bad_signature` once the relay refused this server's signature three times in a row, or `relay_maintenance` from the relay's own status.",
          ),
      })
      .describe(
        "The instance's relay registration, as `push.relay.state` reads it.",
      ),
    binding: z
      .object({
        state: z
          .enum(["none", "bound", "rebind_needed", "conflict"])
          .describe(
            "As `push.device.relayState`: a `conflict` older than 30 minutes reads `rebind_needed`.",
          ),
        consent: z
          .boolean()
          .describe("The person turned the relay on for this device."),
        boundAt: isoDateTime()
          .nullable()
          .describe("When the relay last confirmed the binding."),
      })
      .describe("This device's relay binding."),
    budget: z
      .object({
        windowMinutes: z
          .number()
          .int()
          .describe("The rolling window every limit counts: 60."),
        limit: z
          .number()
          .int()
          .nullable()
          .describe(
            "Silent pushes of every kind per window over the relay: 6. Null over this server's own APNs key, where no overall cap applies.",
          ),
        wakeLimit: z
          .number()
          .int()
          .describe(
            "`DATA_CHANGED` and `HEALTHKIT_CATCH_UP` together per window: 4. Over the relay the last 2 of `limit` stay free for the intake sync.",
          ),
        usedInWindow: z
          .number()
          .int()
          .describe("Silent pushes sent to this device in the window."),
        wakesUsedInWindow: z.number().int().describe("Of those, wakes."),
        owedSyncs: z
          .number()
          .int()
          .describe(
            "Intake syncs held back by the budget and waiting, coalesced: 0 or 1, however many changes arrived. Held back by this server's count, or refused by the relay for its own (`device_quota`); sent once the budget frees up, never dropped.",
          ),
        owedSince: isoDateTime()
          .nullable()
          .describe("Since when the sync is owed."),
        nextFreeAt: isoDateTime()
          .nullable()
          .describe(
            "When the next intake sync fits the budget again (an owed one goes then): by this server's count, or later when the relay named a later time with a refusal; null when one fits now.",
          ),
      })
      .describe(
        "The device's silent budget, from the rule the send asks (`src/lib/push-relay/wakes.ts`).",
      ),
    medicationReminder: z
      .object({
        delivery: z
          .enum(["server", "client"])
          .describe(
            "Who reminds this device of a dose now, by the same decision the send reads: `server` when the server's medication reminder goes to this device (over `transport`, the relay included), `client` while the app reminds locally. The device's `medicationDelivery`, else the account switch; a device that reminds locally counts as `server` once its local plan has run out (`localRunwayUntil`, else 3 days after its last request).",
          ),
        localUntil: isoDateTime()
          .nullable()
          .describe(
            "While `delivery` is `client`: when the server takes over unless the device reports a new runway or shows up again. Null while `delivery` is `server`.",
          ),
      })
      .describe(
        "The medication-reminder delivery resolved for this device. A follow-up for a dose still open goes to every device over this server's own key, and over the relay only while `delivery` is `server`.",
      ),
    lastDelivery: z
      .object({
        alert: lastDelivery,
        silentSync: lastDelivery.describe("`MEDICATION_INTAKE_SYNC`."),
        wake: lastDelivery.describe("`DATA_CHANGED` or `HEALTHKIT_CATCH_UP`."),
        liveActivity: lastDelivery,
      })
      .describe(
        "The newest push of each kind to this device, from the ledger that knows the device. Over the relay, the relay outbox. Over this server's own APNs key, the silent ledger for the sync and the wakes; the alert comes from the account's delivery attempts only while this is the account's one APNs device, because that ledger names no device, and is null otherwise. A Live Activity push over this server's own key leaves no per-device record and stays null.",
      ),
    intakeSync: z
      .object({
        state: z
          .enum(["ok", "degraded"])
          .describe("The same value as `push.device.intakeSync`."),
        reason: z
          .enum(["relay", "intake_recorded_dropped", "alert_unconfirmed"])
          .nullable()
          .describe(
            "Why it reads `degraded`, null while `ok`: the relay is not healthy (`relay`); the last dose confirmation to this device was dropped and no alert opened since (`intake_recorded_dropped`); the newest alert the relay accepted in the last 24 hours was never opened although the device reported receipts well after it (`alert_unconfirmed`). Silent and Live Activity pushes never count (v1.49.0).",
          ),
      })
      .describe(
        "Whether a dose recorded on another device reaches this one, from the last 24 hours of evidence only.",
      ),
    receipt: z
      .object({
        reportedAt: isoDateTime(),
        openedAlert: z.string().nullable(),
        openedSilent: z.string().nullable(),
      })
      .nullable()
      .describe(
        "The last envelope receipt this device posted (`GET /api/sync/state` `openedAlert` / `openedSilent`): the newest envelope ids it opened per class, kept forward only. Null before the first report.",
      ),
    serverTime: isoDateTime(),
  })
  .meta({
    id: "DevicePushDiagnostics",
    description:
      "One device's push state for its diagnostics screen. Only this device: nothing about the account's other devices, no token in clear, no notification content.",
  });

export const devicePaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/devices": {
    post: {
      tags: ["Devices"],
      summary: "Register native device + APNs token",
      description:
        "Idempotent upsert by `token`. APNs token + environment are paired — supplying one without the other returns 422. A `token` (the `X-Device-Id`) or `apnsToken` another account holds is taken over when that account is signed out of the device: its device row goes, with its push key, relay binding (unbound at the relay before this request's binding is forwarded) and Live Activity state, so nothing sealed for it reaches the device. Both accounts get an audit row, and the previous one a security alert on its other devices and channels. Since v1.49.0 a device still signed in to the other account is not taken over: while that account holds a live refresh token for this `X-Device-Id` (or one naming no device), or the access token of a rotation's short sunset, the answer is 409 `devices.register.signed_in_elsewhere` and nothing changes. Signing out there, or that sign-in running out, frees the device; the app can then register again. APNs tokens are hex of up to 512 characters: Apple documents no fixed length. A Live Activity field (`liveActivityPushToken`, an entry of `liveActivityTokens`, `liveActivityStart`) the server cannot take does not fail the registration: it is left out, the device registers with everything else, and the answer's `ignored` names it with `devices.register.invalid_field` for its shape, or with the `devices.push.<reason>` its push-to-start statement was refused for. A refused push field (push key, relay binding, consent) returns 422 with `meta.errorCode` `devices.push.<reason>` and changes nothing; more than 10 new relay bindings for one account in 24 hours return 429 `devices.push.relay_daily_limit`. When the device's APNs token changes, the old token's relay binding is removed and the device has to bind the new token (`relayState: rebind_needed` unless the request carries the new `relayBinding`). The answer's `push` block is the device's push state after the call.",
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
                z.object({
                  id: z.string(),
                  push: devicePushBlockSchema,
                  ignored: z
                    .array(
                      z.object({
                        field: z
                          .string()
                          .describe(
                            "The request field, `liveActivityTokens[<index>]` for one list entry.",
                          ),
                        code: z
                          .string()
                          .describe(
                            "`devices.register.invalid_field` for a value in a shape the server does not take, else the `devices.push.<reason>` the push-to-start statement was refused for.",
                          ),
                      }),
                    )
                    .optional()
                    .describe(
                      "v1.49.1. The optional Live Activity fields left out of this registration instead of failing it; absent when none was. A left-out `liveActivityPushToken` or `liveActivityStart` keeps its stored value.",
                    ),
                }),
                "DeviceRegisterResponse",
              ),
            },
          },
        },
        "409": {
          description:
            "`devices.register.signed_in_elsewhere`: the `token` or `apnsToken` belongs to a device still signed in to another account. Nothing changed; both accounts get an audit row.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/devices/me/push-diagnostics": {
    get: {
      tags: ["Devices"],
      summary: "The calling device's push diagnostics",
      description:
        "v1.49.0. The push state of the device named by `X-Device-Id` (the same header `push.device` on `/api/auth/me` reads): route, relay binding, silent budget, owed sync, last delivery per kind, last receipt and the masked APNs token. A cookie session or a wildcard token; a narrow token is refused with 403. A header that is missing or names none of the caller's devices answers 404, the same for another account's device as for one that does not exist. 10 requests a minute per account. `Cache-Control: private, no-store`.",
      parameters: [
        {
          name: "X-Device-Id",
          in: "header",
          required: true,
          schema: { type: "string" },
          description: "The device's registration `token`.",
        },
      ],
      responses: {
        "200": {
          description: "The device's push diagnostics.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                devicePushDiagnostics,
                "DevicePushDiagnosticsEnvelope",
              ),
            },
          },
        },
        "404": {
          description: "The header names none of the caller's devices.",
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

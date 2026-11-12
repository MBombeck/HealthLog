/**
 * OpenAPI route table — notification channels: per-event preferences and
 * per-channel delivery health.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The request
 * bodies come from `src/lib/validations/notifications.ts` so the wire contract
 * stays single-source; the response DTOs mirror the handlers under
 * `src/app/api/notifications/*`.
 *
 * The channel and event vocabularies are read from
 * `src/lib/notifications/types.ts` rather than restated, so a new channel type
 * or event category cannot be added to the dispatcher and quietly go missing
 * from the published contract.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import { CHANNEL_TYPES, EVENT_TYPES } from "@/lib/notifications/types";
import {
  QUICK_ACTION_IDS,
  type QuickActionId,
} from "@/lib/notifications/action-token";
import {
  notificationPreferenceSchema,
  reEnableChannelSchema,
} from "@/lib/validations/notifications";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";
import { isoDateTime } from "@/lib/validations/datetime";

const channelTypeEnum = z
  .enum(CHANNEL_TYPES)
  .describe("Delivery transport for a notification channel.");

const eventTypeEnum = z
  .enum(EVENT_TYPES)
  .describe("Notification category a per-channel preference can toggle.");

const notificationChannel = z
  .object({
    id: z.string(),
    type: channelTypeEnum,
    label: z
      .string()
      .describe(
        "Human-readable channel name. Falls back to the raw `type` when no label is registered.",
      ),
    enabled: z.boolean().describe("The user's own per-channel toggle."),
    globallyEnabled: z
      .boolean()
      .describe(
        "The operator's instance-wide toggle for this transport. Only TELEGRAM, NTFY and WEB_PUSH have one; every other transport reports `true`. A channel the user has enabled still sends nothing while this is false.",
      ),
  })
  .meta({
    id: "NotificationChannelSummary",
    description:
      "One of the caller's notification channels, with both the per-user and the instance-wide toggle so a client can explain why an enabled channel is silent.",
  });

const notificationPreference = z
  .object({
    channelId: z.string(),
    eventType: eventTypeEnum,
    enabled: z.boolean(),
  })
  .meta({
    id: "NotificationPreference",
    description:
      "An explicit per-(channel, event) override. Only STORED rows appear — an event with no row here follows `eventDefaults` on the same response. Absence is therefore not 'disabled'.",
  });

const notificationPreferencesResponse = z
  .object({
    channels: z.array(notificationChannel),
    preferences: z.array(notificationPreference),
    eventTypes: z
      .array(z.string())
      .describe(
        "The event categories this account is shown a switch for, in declaration order: the list a client renders rows for. A category nothing sends is not listed, and `preferences` carries no stored row for it.",
      ),
    eventDefaults: z
      .record(eventTypeEnum, z.boolean())
      .describe(
        "What each event does on a channel with no stored row, resolved for this account by the function delivery uses. Most are constant per category; the mood reminder follows the account's mood-reminder setting (`moodReminderEnabled` on `/api/user/profile`). Render a switch without a row from this map rather than from a copy of the defaults. Since v1.43.11.",
      ),
  })
  .meta({
    id: "NotificationPreferencesResponse",
    description:
      "The caller's notification channels, their stored per-event overrides, and the event categories they can switch.",
  });

const notificationPreferenceRequest = notificationPreferenceSchema.meta({
  id: "NotificationPreferenceRequest",
  description:
    "Set one per-(channel, event) override. `channelId` must belong to the caller — a channel id owned by somebody else answers 404, not 403. Upsert: the row is created when absent.",
});

const channelDeliveryStatus = z
  .object({
    id: z.string(),
    type: channelTypeEnum,
    label: z.string(),
    enabled: z.boolean(),
    state: z
      .enum(["active", "auto_disabled", "manually_disabled", "sending_paused"])
      .describe(
        "Server-derived. `auto_disabled` — the dispatcher turned it off after repeated hard rejects (`disabledReason` says why). `manually_disabled` — the user turned it off. `sending_paused` — still enabled but inside a retry cooldown until `nextRetryAt`, after a transient failure or after a send that had nobody to go to (no browser subscribed, no iPhone paired, a transport the operator has not set up; `lastFailureReason` names it, `consecutiveFailures` is not raised). `active` — enabled and sending.",
      ),
    disabledReason: z
      .string()
      .nullable()
      .describe(
        "Why the dispatcher auto-disabled the channel; null when it did not. This is the field that separates `auto_disabled` from `manually_disabled`.",
      ),
    consecutiveFailures: z.number().int(),
    lastSuccessAt: isoDateTime().nullable(),
    lastFailureAt: isoDateTime().nullable(),
    lastFailureReason: z.string().nullable(),
    nextRetryAt: isoDateTime()
      .nullable()
      .describe("End of the current cooldown; null when not paused."),
  })
  .meta({
    id: "NotificationChannelDeliveryStatus",
    description:
      "Delivery health for one channel: the derived state plus the raw counters and timestamps behind it.",
  });

const eventDeliveryStatus = z
  .object({
    lastDeliveredAt: isoDateTime()
      .nullable()
      .describe("Null when this category has never been delivered."),
  })
  .meta({ id: "NotificationEventDeliveryStatus" });

const notificationStatusResponse = z
  .object({
    channels: z.array(channelDeliveryStatus),
    events: z
      .record(z.string(), eventDeliveryStatus)
      .describe(
        "Keyed by event category. EVERY known category is present, with `lastDeliveredAt: null` when no data exists, so a client can render an empty row without conditional plumbing. Only categories with their own dispatch ledger can ever report a non-null instant — today that is `MOOD_REMINDER` alone; every other category reports null regardless of what was actually delivered.",
      ),
  })
  .meta({
    id: "NotificationStatusResponse",
    description:
      "Per-channel delivery health plus a per-category last-delivered map.",
  });

const reEnableChannelRequest = reEnableChannelSchema.meta({
  id: "ReEnableNotificationChannelRequest",
  description:
    "Clear the auto-disable on one of the caller's own channels. A channel id the caller does not own answers 404.",
});

const notificationActionResult = z
  .object({
    logged: z.literal(true),
    action: z
      .enum(QUICK_ACTION_IDS as [QuickActionId, ...QuickActionId[]])
      .describe(
        "The answer that was logged: mood-good = 4 (GUT), mood-okay = 3 (OKAY), mood-bad = 2 (SCHLECHT) on the five-point mood scale.",
      ),
  })
  .meta({
    id: "NotificationActionResult",
    description: "A quick answer from a notification, logged as a mood entry.",
  });

export const notificationChannelPaths: NonNullable<ZodOpenApiObject["paths"]> =
  {
    "/api/notifications/action/{token}": {
      post: {
        tags: ["Notifications"],
        summary: "Log a quick answer tapped inside a notification",
        description:
          "Called by a notification app (ntfy `http` action), never by a signed-in client: the signed path token is the only credential. The token is bound to one user and one answer, expires six hours after the reminder was sent, and is single-use across all answers offered on that reminder. Rate-limited per client address before the token is read. Writes a mood entry with source `NOTIFICATION`; refused with 403 when the mood module is off.",
        requestParams: {
          path: z.object({
            token: z
              .string()
              .describe("Signed action token from the notification's URL."),
          }),
        },
        responses: {
          "200": {
            description: "The answer was logged.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  notificationActionResult,
                  "NotificationActionResponse",
                ),
              },
            },
          },
          ...stdResponses,
          "401": {
            description: "Invalid token (forged, altered, or unknown user).",
            content: { "application/json": { schema: errorEnvelope } },
          },
          "403": {
            description: "The mood module is turned off for this account.",
            content: { "application/json": { schema: errorEnvelope } },
          },
          "409": {
            description: "This reminder was already answered.",
            content: { "application/json": { schema: errorEnvelope } },
          },
          "410": {
            description: "The answer expired.",
            content: { "application/json": { schema: errorEnvelope } },
          },
        },
      },
    },
    "/api/notifications/preferences": {
      get: {
        tags: ["Notifications"],
        summary: "Read the caller's notification channels and preferences",
        description:
          "Returns every channel the caller has, its stored per-event overrides, and the full event vocabulary. Not a pure read: a user whose Telegram config still lives only on the legacy `User` columns has it migrated into a channel row as a side effect of this call, and that migration failing is swallowed as a warning rather than surfaced. Auth via cookie or Bearer.",
        responses: {
          "200": {
            description: "Channels, stored overrides and event vocabulary.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  notificationPreferencesResponse,
                  "GetNotificationPreferences",
                ),
              },
            },
          },
          ...stdResponses,
        },
      },
      put: {
        tags: ["Notifications"],
        summary: "Set one per-channel notification preference",
        description:
          "Upserts a single (channel, event) override and echoes the stored row. One preference per call — there is no batch arm. Body capped at 64 KiB. Auth via cookie or Bearer.",
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: notificationPreferenceRequest },
          },
        },
        responses: {
          "200": {
            description: "The stored preference.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  notificationPreference,
                  "PutNotificationPreferenceResponse",
                ),
              },
            },
          },
          "404": {
            description: "No such channel for this caller.",
            content: { "application/json": { schema: errorEnvelope } },
          },
          "413": {
            description: "Body exceeds 64 KiB.",
            content: { "application/json": { schema: errorEnvelope } },
          },
          ...stdResponses,
          "422": {
            description:
              "Body is not parseable JSON, or failed validation. Note that unlike the routes wrapped in `safeJson`, a malformed body here is 422 rather than 400, and no Content-Type check runs.",
            content: { "application/json": { schema: errorEnvelope } },
          },
        },
      },
    },
    "/api/notifications/status": {
      get: {
        tags: ["Notifications"],
        summary: "Read per-channel delivery health",
        description:
          "What the notification settings surface paints into its Active / Auto-disabled / Sending-paused badges, plus a per-category last-delivered map. Auth via cookie or Bearer.",
        responses: {
          "200": {
            description: "Delivery health per channel and per category.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  notificationStatusResponse,
                  "GetNotificationStatus",
                ),
              },
            },
          },
          ...stdResponses,
        },
      },
      post: {
        tags: ["Notifications"],
        summary: "Re-enable an auto-disabled channel",
        description:
          "Clears `disabledReason`, `consecutiveFailures` and `nextRetryAt`, sets `enabled` true, and audits the change. Accepted on any of the caller's channels, not only auto-disabled ones — re-enabling an already-active channel is a no-op that still answers 200. Follow up with a test send if the client wants confirmation the transport works again. Body capped at 64 KiB. Auth via cookie or Bearer.",
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: reEnableChannelRequest },
          },
        },
        responses: {
          "200": {
            description: "The channel was re-enabled.",
            content: {
              "application/json": {
                schema: dataEnvelope(
                  z.object({ ok: z.literal(true) }),
                  "ReEnableNotificationChannelResponse",
                ),
              },
            },
          },
          "404": {
            description: "No such channel for this caller.",
            content: { "application/json": { schema: errorEnvelope } },
          },
          "413": {
            description: "Body exceeds 64 KiB.",
            content: { "application/json": { schema: errorEnvelope } },
          },
          ...stdResponses,
          "422": {
            description:
              "Body is not parseable JSON, or failed validation. As above, a malformed body here is 422 rather than 400.",
            content: { "application/json": { schema: errorEnvelope } },
          },
        },
      },
    },
  };

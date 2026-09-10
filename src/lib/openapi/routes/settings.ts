/**
 * OpenAPI route table — settings surfaces: the reminder thresholds, the
 * operator's instance-wide service switches, and account deletion.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import {
  emailSettingsSchema,
  notificationChannelEnabledSchema,
  ntfySettingsSchema,
  webhookSettingsSchema,
} from "@/lib/validations/notifications";
import { telegramSettingsSchema } from "@/lib/validations/telegram";
import {
  dataEnvelope,
  errorEnvelope,
  recordRefusal,
  SHARING_NOT_PERMITTED_DESCRIPTION,
  stdResponses,
} from "./shared";

// v1.16.11 — the one threshold read every dose-status consumer makes
// (cards, table, take-all-due derivation). `lateMinutes` /
// `missedMinutes` are the operator-level singleton; the low-stock
// runway threshold rides along but is PER-USER (written through
// `PATCH /api/auth/me/notification-prefs`).
const reminderThresholdsResponse = z
  .object({
    lateMinutes: z
      .number()
      .int()
      .describe(
        "Minutes after the dose anchor at which an open dose tiers 'late' (operator-level singleton; default 120).",
      ),
    missedMinutes: z
      .number()
      .int()
      .describe(
        "Minutes after the dose anchor at which an open dose tiers 'missed' (operator-level singleton; default 240).",
      ),
    lowStockRunwayDays: z
      .number()
      .int()
      .min(1)
      .max(60)
      .nullable()
      .describe(
        "Per-user low-stock alert threshold as remaining runway days (1–60). null = the alert is off. Default 7. Written via PATCH /api/auth/me/notification-prefs.",
      ),
    reorderLeadDays: z
      .number()
      .int()
      .min(0)
      .max(60)
      .describe(
        "v1.17.0 — per-user reorder lead default in days (0–60, default 10). The low-stock alert fires this lead plus one dose-interval before the supply runs out so a refill arrives before the last dose; a per-medication reorderLeadDays overrides it. Written via PATCH /api/auth/me/notification-prefs.",
      ),
  })
  .meta({
    id: "ReminderThresholdsResponse",
    description:
      "Medication reminder thresholds: the operator-level late/missed minute marks plus the calling user's low-stock runway threshold (v1.16.11).",
  });

// ── Instance-level service switches ──────────────────────────────────

const globalServiceAvailabilityResponse = z
  .object({
    telegramGlobal: z.boolean().describe("Telegram notifications are offered."),
    ntfyGlobal: z.boolean().describe("ntfy notifications are offered."),
    webPushGlobal: z.boolean().describe("Web Push is offered."),
    apiGlobal: z
      .boolean()
      .describe(
        "The API-token surface is on. When false, `/api/tokens` and its revoke sibling answer 403 — the read included.",
      ),
  })
  .meta({
    id: "GlobalServiceAvailability",
    description:
      "Which optional services the operator has left switched on instance-wide. Every flag defaults to true, and a failed settings read returns all-true rather than an error, so a client must not treat this as proof a channel is configured — only that the operator has not switched it off.",
  });

// ── Account deletion ─────────────────────────────────────────────────
// The body is hand-parsed rather than Zod-validated (the handler reads the raw
// text, caps it, and compares one field), so the shape is described here rather
// than imported. Documenting it as a schema is still right: it is the wire
// contract, whatever the handler uses to check it.

const deleteAccountRequest = z
  .object({
    confirm: z
      .literal("DELETE_ACCOUNT")
      .describe(
        "The literal string `DELETE_ACCOUNT`. Any other value, and any non-string, is refused with 422.",
      ),
  })
  .meta({
    id: "DeleteAccountRequest",
    description:
      "Typed confirmation for permanent account deletion. There is no second step and no undo.",
  });

// ── Email channel, channel self-tests, the data wipe, privacy facts ──

const emailChannelResponse = z
  .object({
    enabled: z.boolean(),
    recipient: z
      .string()
      .describe("The saved recipient address, or an empty string when none."),
    smtpConfigured: z
      .boolean()
      .describe(
        "Whether the OPERATOR has configured an SMTP transport. False means no email can be sent from this instance whatever the user saves, so a client should hide the card rather than offer a control that cannot work.",
      ),
  })
  .meta({
    id: "EmailChannelResponse",
    description:
      "The per-user email channel. Only the recipient is per-user — host, port, credentials and sender come from the operator's environment and never enter a user's encrypted channel blob.",
  });

const emailChannelPutRequest = z
  .union([notificationChannelEnabledSchema, emailSettingsSchema])
  .meta({
    id: "EmailChannelPutRequest",
    description:
      "Two accepted shapes. `{ enabled }` alone toggles the existing channel without restating the address — and is refused with 422 when no recipient has ever been saved, because enabling a channel with nowhere to send is not a state worth storing. `{ recipient, enabled }` upserts both; `recipient` may be an empty string only while `enabled` is false.",
  });

const channelTestResponse = z.object({ sent: z.literal(true) }).meta({
  id: "ChannelTestResponse",
  description:
    "The provider accepted the test message. Acceptance is not delivery — a message can still be dropped downstream.",
});

const privacySummaryResponse = z
  .object({
    retention: z
      .object({
        coachMessagesDays: z
          .number()
          .int()
          .describe(
            "How long Coach conversation history is kept. Operator-configurable, floor 30, default 365.",
          ),
        auditLogDays: z
          .number()
          .int()
          .describe(
            "How long audit history is kept. Read from the same resolver the purge job uses, so the number a person is shown is the number that is enforced.",
          ),
        deliveryLogDays: z
          .number()
          .int()
          .describe(
            "Fixed 90-day window on the push-attempt and mood-dispatch ledgers.",
          ),
      })
      .describe(
        "Retention windows as the privacy dashboard states them. Off-host backup retention is operator infrastructure rather than an app setting and is deliberately absent — it is disclosed as prose in the UI, not as a number here.",
      ),
    encryption: z
      .object({
        algorithm: z.literal("AES-256-GCM"),
        columnCount: z
          .number()
          .int()
          .describe("How many columns are encrypted at rest."),
        modelCount: z
          .number()
          .int()
          .describe("How many models carry at least one of them."),
      })
      .describe(
        "Counted from the canonical encrypted-column registry rather than hand-maintained, so the disclosure cannot drift from what is actually encrypted.",
      ),
  })
  .meta({
    id: "PrivacySummaryResponse",
    description:
      "Server-authoritative facts for the Data & Privacy dashboard. No key material, no secrets, no per-row data — the same numbers for every account on the instance.",
  });

const dataWipeRequest = z
  .object({
    confirm: z
      .literal("DELETE")
      .describe(
        "The literal string `DELETE`. Note it is NOT the `DELETE_ACCOUNT` string the account-deletion route wants — the two confirmations are deliberately different so one cannot be pasted into the other.",
      ),
  })
  .meta({
    id: "DataWipeRequest",
    description: "Typed confirmation for erasing the record. No undo.",
  });

const dataWipeResponse = z
  .object({
    cleared: z.literal(true),
    deletedRows: z.number().int().describe("Total rows removed."),
    models: z
      .record(z.string(), z.number().int())
      .describe(
        "Per-model row counts, listing only the models that actually had rows. A model absent from this map had nothing to delete — it was not skipped.",
      ),
  })
  .meta({ id: "DataWipeResponse" });

// ── Per-channel notification config ──────────────────────────────────
// Three credential-bearing channels the Settings page and the iOS client both
// write. Every GET here reports the SECRET AS A BOOLEAN and never the value:
// `hasAuthToken` (ntfy), `hasBotToken` (Telegram), `hasHeaderValue` (webhook).
// The PUT side is what that costs: because a client cannot read the secret back,
// an empty value on the way in means "keep what is stored", never "clear it".

const jsonBodyRefusals = {
  "400": {
    description: "Body is not parseable JSON.",
    content: { "application/json": { schema: errorEnvelope } },
  },
  "413": {
    description: "Body exceeds 64 KiB.",
    content: { "application/json": { schema: errorEnvelope } },
  },
  "415": {
    description: "Content-Type is not `application/json`.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

const channelEnabledOnlyRequest = notificationChannelEnabledSchema.meta({
  id: "NotificationChannelEnabledRequest",
  description:
    "The toggle-only arm of a channel PUT: exactly `{ enabled }` and nothing else. Any additional key falls through to the channel's full config body instead. Enabling a channel whose stored config is incomplete fails with 422.",
});

const ntfySettingsRequest = ntfySettingsSchema.meta({
  id: "NtfySettingsRequest",
  description:
    "ntfy channel config. `serverUrl` must pass the SSRF floor — a URL resolving into a private range is refused at input time. An EMPTY OR OMITTED `authToken` preserves the stored one rather than clearing it: the GET never returns the secret, so a client round-tripping the form would otherwise wipe it on every unrelated save. Sending a non-empty value replaces it. There is no way to clear a stored auth token through this endpoint.",
});

const telegramSettingsRequest = telegramSettingsSchema.meta({
  id: "TelegramSettingsRequest",
  description:
    "Telegram channel config. Both credential fields are optional and behave by key PRESENCE, not by value: omit `botToken` to keep the stored one, send an empty string to clear it. Same for `chatId`. Enabling the channel registers the Telegram webhook against `APP_URL` as part of the write, so a deployment whose `APP_URL` is not a public HTTPS host on port 80/88/443/8443 cannot enable Telegram at all.",
});

const webhookSettingsRequest = webhookSettingsSchema.meta({
  id: "WebhookSettingsRequest",
  description:
    "Generic-webhook channel config — one channel covering Gotify, Discord, Slack, a Matrix bridge, Home Assistant, or any relay accepting an inbound JSON POST. `url` must pass the SSRF floor at input time and is re-checked at dispatch time. An EMPTY OR OMITTED `headerValue` preserves the stored one, for the same reason as ntfy's `authToken`: the GET never returns it. There is no way to clear a stored header value through this endpoint.",
});

/**
 * The two shapes every channel PUT accepts, as one `anyOf`.
 *
 * The handler tries the strict `{ enabled }` object first and falls through to
 * the full config schema, so the wire genuinely admits either. Publishing only
 * the full schema would tell a client it has to resend the whole config to flip
 * a toggle — exactly the round-trip the preserve-on-empty rule exists to
 * survive, and exactly the round-trip that used to wipe the stored secret.
 */
const ntfyPutRequest = z
  .union([channelEnabledOnlyRequest, ntfySettingsRequest])
  .meta({
    id: "NtfySettingsPutRequest",
    description:
      "Either the toggle-only body or the full ntfy config. The toggle arm is tried first and matches only an object with `enabled` and no other key.",
  });

const telegramPutRequest = z
  .union([channelEnabledOnlyRequest, telegramSettingsRequest])
  .meta({
    id: "TelegramSettingsPutRequest",
    description:
      "Either the toggle-only body or the full Telegram config. The toggle arm is tried first and matches only an object with `enabled` and no other key.",
  });

const webhookPutRequest = z
  .union([channelEnabledOnlyRequest, webhookSettingsRequest])
  .meta({
    id: "WebhookSettingsPutRequest",
    description:
      "Either the toggle-only body or the full webhook config. The toggle arm is tried first and matches only an object with `enabled` and no other key.",
  });

const ntfySettingsResponse = z
  .object({
    enabled: z.boolean(),
    serverUrl: z
      .string()
      .describe("Defaults to `https://ntfy.sh` when no channel row exists."),
    topic: z.string().describe("Empty string when unset."),
    hasAuthToken: z
      .boolean()
      .describe(
        "Whether an auth token is stored. The token itself is never returned.",
      ),
  })
  .meta({
    id: "NtfySettingsResponse",
    description:
      "Stored ntfy channel config, with the auth token reduced to a presence flag.",
  });

const telegramSettingsResponse = z
  .object({
    enabled: z.boolean(),
    hasBotToken: z
      .boolean()
      .describe(
        "Whether a bot token is stored. The token itself is never returned.",
      ),
    chatId: z
      .string()
      .nullable()
      .describe(
        "The stored chat id, returned in full. It is an addressing value, not a credential — the bot token is what authorises a send.",
      ),
  })
  .meta({
    id: "TelegramSettingsResponse",
    description:
      "Stored Telegram channel config, with the bot token reduced to a presence flag.",
  });

const webhookSettingsResponse = z
  .object({
    enabled: z.boolean(),
    url: z.string().describe("Empty string when no channel row exists."),
    headerName: z
      .string()
      .describe("Empty string when unset. The header NAME is not a secret."),
    hasHeaderValue: z
      .boolean()
      .describe(
        "Whether a header value (the shared secret) is stored. The value itself is never returned.",
      ),
  })
  .meta({
    id: "WebhookSettingsResponse",
    description:
      "Stored generic-webhook channel config, with the secret header value reduced to a presence flag.",
  });

const channelSaved = z.object({ saved: z.literal(true) });
const channelUpdated = z.object({ updated: z.literal(true) });

export const settingsPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/settings/ntfy": {
    get: {
      tags: ["Notifications"],
      summary: "Read the caller's ntfy channel config",
      description:
        'Returns the stored server URL, topic and enabled flag. The auth token is reported as `hasAuthToken` only. When the user has no ntfy channel row the defaults `{ enabled: false, serverUrl: "https://ntfy.sh", topic: "", hasAuthToken: false }` are returned rather than a 404. Auth via cookie or Bearer.',
      responses: {
        "200": {
          description: "Stored (or default) ntfy config.",
          content: {
            "application/json": {
              schema: dataEnvelope(ntfySettingsResponse, "GetNtfySettings"),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Notifications"],
      summary: "Update the caller's ntfy channel config",
      description:
        "Upserts the channel. Accepts either the toggle-only body or the full config. The response is `{ saved: true }` and carries no config echo, so re-read the GET if the client needs the resolved state. Auth via cookie or Bearer.\n\n" +
        "An operator can switch ntfy off for the whole instance. While that switch is off, a body that sets `enabled` to true is refused with 403 and nothing is stored — the channel would not deliver, so the toggle does not pretend otherwise. Disabling the channel keeps working either way. Read the switch from `GET /api/settings/global-services`.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: ntfyPutRequest } },
      },
      responses: {
        "200": {
          description: "Config stored.",
          content: {
            "application/json": {
              schema: dataEnvelope(channelSaved, "PutNtfySettingsResponse"),
            },
          },
        },
        "403": {
          description:
            "The operator switched ntfy off for this instance and the body asked to enable it. Nothing was stored.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...jsonBodyRefusals,
        ...stdResponses,
        "422": {
          description:
            "Body matched neither accepted shape, or `enabled` is true while the stored config has no server URL and topic.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/settings/telegram": {
    get: {
      tags: ["Notifications"],
      summary: "Read the caller's Telegram channel config",
      description:
        "Returns the enabled flag, the chat id and `hasBotToken`. The bot token is never returned. Auth via cookie or Bearer.",
      responses: {
        "200": {
          description: "Stored Telegram config.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                telegramSettingsResponse,
                "GetTelegramSettings",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Notifications"],
      summary: "Update the caller's Telegram channel config",
      description:
        "Accepts either the toggle-only body or the full config, then registers (on enable) or deletes (on disable) the Telegram webhook for the bot before persisting. Webhook deletion is best-effort and its failure does not fail the write; webhook REGISTRATION is not — a rejected registration aborts the whole call and nothing is stored. The response is `{ updated: true }` with no config echo. Auth via cookie or Bearer.\n\n" +
        "An operator can switch Telegram off for the whole instance. While that switch is off, a body that sets `enabled` to true is refused with 403 before any webhook call and nothing is stored. Disabling the channel keeps working either way. Read the switch from `GET /api/settings/global-services`.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: telegramPutRequest } },
      },
      responses: {
        "200": {
          description: "Config stored.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                channelUpdated,
                "PutTelegramSettingsResponse",
              ),
            },
          },
        },
        "403": {
          description:
            "The operator switched Telegram off for this instance and the body asked to enable it. No webhook was registered and nothing was stored.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "404": {
          description: "The session's user row no longer exists.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...jsonBodyRefusals,
        "500": {
          description:
            "The deployment cannot register a Telegram webhook because `APP_URL` (or `NEXT_PUBLIC_APP_URL`) is missing or unparseable. An operator configuration problem, not a client one — retrying will not help.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "Body matched neither accepted shape; or `enabled` is true without both a bot token and a chat id; or the deployment's `APP_URL` is not a public HTTPS host on port 80/88/443/8443; or Telegram refused the webhook registration.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/settings/webhook": {
    get: {
      tags: ["Notifications"],
      summary: "Read the caller's generic-webhook channel config",
      description:
        'Returns the stored URL, header name and enabled flag. The secret header value is reported as `hasHeaderValue` only. When the user has no webhook channel row the defaults `{ enabled: false, url: "", headerName: "", hasHeaderValue: false }` are returned rather than a 404. Auth via cookie or Bearer.',
      responses: {
        "200": {
          description: "Stored (or default) webhook config.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                webhookSettingsResponse,
                "GetWebhookSettings",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Notifications"],
      summary: "Update the caller's generic-webhook channel config",
      description:
        "Upserts the channel. Accepts either the toggle-only body or the full config. The response is `{ saved: true }` and carries no config echo. Auth via cookie or Bearer.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: webhookPutRequest } },
      },
      responses: {
        "200": {
          description: "Config stored.",
          content: {
            "application/json": {
              schema: dataEnvelope(channelSaved, "PutWebhookSettingsResponse"),
            },
          },
        },
        ...jsonBodyRefusals,
        ...stdResponses,
        "422": {
          description:
            "Body matched neither accepted shape, or `enabled` is true while no webhook URL is stored.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/settings/reminder-thresholds": {
    get: {
      tags: ["Notifications"],
      summary: "Read the medication reminder thresholds",
      description:
        "Returns the operator-level late/missed minute thresholds that tier an open dose's status, plus the calling user's low-stock runway threshold (days; null = alert off). One endpoint so every threshold consumer reads one shape. Auth via cookie or Bearer.",
      responses: {
        ...recordRefusal(),
        "200": {
          description: "Resolved thresholds.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                reminderThresholdsResponse,
                "GetReminderThresholdsResponse",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  // ── Appended: two settings surfaces the registry never carried.
  "/api/settings/global-services": {
    get: {
      tags: ["Notifications"],
      summary: "Read the operator's instance-wide service switches",
      description:
        "Which optional services this instance offers at all, so a client can hide a channel the operator has switched off rather than let a user configure something that will never deliver. Auth via cookie or a wildcard Bearer token; the answer is about the DEPLOYMENT and is identical for every account on it.\n\n" +
        "Reads fail soft: when the settings row cannot be loaded the handler returns all-true rather than an error, so a true flag means “not switched off”, never “configured and working”.",
      responses: {
        "200": {
          description: "The instance's service switches.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                globalServiceAvailabilityResponse,
                "GlobalServiceAvailabilityEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/settings/account": {
    delete: {
      tags: ["Auth"],
      summary: "Permanently delete the account and everything in it",
      description:
        "Erasure, not deactivation: the user row goes, every related row cascades with it, and the account's own audit history — IP addresses, login geo — is purged inside the same transaction rather than being left orphaned. There is no undo and no grace period.\n\n" +
        "Two gates, and they compose. The body must carry the typed confirmation. And for an account with a second factor enrolled — a confirmed TOTP secret OR a registered security key — the caller must additionally present a fresh factor proof. An account with NO second factor keeps the typed-confirmation-only contract on either transport, deliberately, because a user who never enrolled has no ceremony to complete.\n\n" +
        "How the fresh proof is presented depends on the transport. A cookie session carries it on the session row: complete the second factor within the last five minutes and retry. A Bearer caller presents a single-use elevation from `POST /api/auth/step-up` in the `X-Step-Up` header, minted against a `totp`, `webauthn`, or `passkey` proof — a `password`-proved elevation is refused here exactly as a password login never satisfies step-up on the web. The elevation is bound to the token that minted it, valid five minutes, and spent only when the deletion is about to run, so a rejected confirmation does not burn it. A recovery code is not accepted on the Bearer path: the mint does not take one, so an account that has lost its authenticator deletes itself from the web.\n\n" +
        "Two refusals are not about the caller's credentials at all. The last remaining admin cannot delete themselves, and the last Guardian of a managed profile cannot leave that profile unattended.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: deleteAccountRequest } },
      },
      responses: {
        "200": {
          description: "Account and all associated data deleted.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.boolean() }),
                "DeleteAccountEnvelope",
              ),
            },
          },
        },
        "400": {
          description:
            "This is the last admin account on the instance and cannot be deleted. Promote another admin first.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "The caller is the last Guardian of a managed profile (`meta.errorCode` = `managed_profile.guardian.required`). Add another Guardian, or delete the managed profile, before deleting this account. Nothing was deleted.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "Request body exceeds 65536 bytes. Nothing was deleted.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "401": {
          description:
            "Not authenticated — or the account has a second factor and the caller carries no proof of it fresh enough for a destructive action (`meta.errorCode` = `auth.stepup.required`, or `auth.stepup.mfa_not_enrolled`). On a cookie session, re-verify the factor and retry; on a Bearer token, mint an elevation at `POST /api/auth/step-up` with a `totp`, `webauthn`, or `passkey` proof and resend with `X-Step-Up`. The same code covers an elevation that is unknown, expired, already spent, minted for a different token, or minted from too weak a factor — the refusals are deliberately indistinguishable on the wire, and the real reason is audited.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "403": {
          description:
            "The Bearer token carries a narrow scope. Erasure needs a cookie session or a full-access token; the refusal happens before any second-factor proof is looked at.\n\n" +
            SHARING_NOT_PERMITTED_DESCRIPTION,
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },

  // ── Appended: the email channel, the four channel self-tests, the record
  // wipe and the privacy dashboard's facts.
  "/api/settings/email": {
    get: {
      tags: ["Notifications"],
      summary: "Read the email channel",
      description:
        'The caller\'s recipient address and opt-in, plus whether the operator has configured SMTP at all. An account that has never saved a channel gets `{ enabled: false, recipient: "" }` rather than a 404, so a client can render the empty form without branching.\n\n' +
        "Read `smtpConfigured` before offering the control: it is an instance fact, and when it is false nothing this endpoint saves can ever be delivered.",
      responses: {
        "200": {
          description: "The channel, and whether the instance can send at all.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                emailChannelResponse,
                "GetEmailChannelEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    put: {
      tags: ["Notifications"],
      summary: "Save the email channel",
      description:
        "Accepts either shape: `{ enabled }` to toggle an existing channel, or `{ recipient, enabled }` to upsert both. The recipient is stored encrypted; SMTP credentials are the operator's and never enter it.\n\n" +
        "Enabling without a saved recipient is refused — both when the toggle-only body finds no stored address and when the full body carries `enabled: true` with an empty one. Body capped at 16 KB.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: emailChannelPutRequest } },
      },
      responses: {
        "200": {
          description: "Channel saved.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ saved: z.literal(true) }),
                "PutEmailChannelEnvelope",
              ),
            },
          },
        },
        "400": {
          description:
            "The operator has configured no SMTP transport, so there is nothing to save a channel against. An instance-level refusal, not a validation error — which is why it is 400 rather than 422.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/settings/email/test": {
    post: {
      tags: ["Notifications"],
      summary: "Send a test email to the saved recipient",
      description:
        "Fires one message through the operator's SMTP transport to the address saved on this account. Takes no body. Rate-limited 5 per 5 minutes per user.\n\n" +
        "Refuses with 400 when the instance has no SMTP transport, when the account has no email channel, or when the channel carries no recipient — three distinguishable prose messages on one status. A transport failure is a 500.",
      responses: {
        "200": {
          description:
            "The provider accepted the message. Not proof it was delivered.",
          content: {
            "application/json": {
              schema: dataEnvelope(channelTestResponse, "EmailTestEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/settings/ntfy/test": {
    post: {
      tags: ["Notifications"],
      summary: "Send a test message to the saved ntfy topic",
      description:
        "Publishes one message to the account's configured ntfy server and topic. Takes no body. Rate-limited 5 per 5 minutes per user. Refuses with 400 when no ntfy channel is saved or when the saved config is missing a server URL or topic; a publish failure is a 500.",
      responses: {
        "200": {
          description:
            "The provider accepted the message. Not proof it was delivered.",
          content: {
            "application/json": {
              schema: dataEnvelope(channelTestResponse, "NtfyTestEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/settings/telegram/test": {
    post: {
      tags: ["Notifications"],
      summary: "Send a test message to the saved Telegram chat",
      description:
        "Sends one message through the account's saved bot token and chat id, in the account's own interface language. Takes no body. Rate-limited 5 per 5 minutes per user.\n\n" +
        "This one differs from its siblings: both the not-configured case and the send failure answer 422 rather than 400 and 500. The failure is genuinely ambiguous — a wrong token and a wrong chat id look the same from here — so one message covers both.",
      responses: {
        "200": {
          description:
            "The provider accepted the message. Not proof it was delivered.",
          content: {
            "application/json": {
              schema: dataEnvelope(channelTestResponse, "TelegramTestEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/settings/webhook/test": {
    post: {
      tags: ["Notifications"],
      summary: "Send a test payload to the saved webhook",
      description:
        "Posts one payload to the account's configured webhook URL. Takes no body. Rate-limited 5 per 5 minutes per user. Refuses with 400 when no webhook channel is saved or the saved config has no URL; a delivery failure is a 500. The URL was checked against the SSRF floor when it was saved, so a test cannot be used to reach an internal host.",
      responses: {
        "200": {
          description:
            "The provider accepted the message. Not proof it was delivered.",
          content: {
            "application/json": {
              schema: dataEnvelope(channelTestResponse, "WebhookTestEnvelope"),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/settings/data": {
    delete: {
      tags: ["Auth"],
      summary: "Erase the record, keeping the account",
      description:
        "The other half of account deletion: this removes what the account HAS and keeps what signs into it. Ninety-nine models are hard-deleted for this user — measurements and every derived rollup, medications and their intake history, mood, labs, documents, cycle, workouts, nutrients, notification channels, Coach conversations, consent receipts, audit history — with no `deletedAt` filter, so soft-deleted tombstones go too. The account row survives with its personal columns reset: body and identity fields, home location, cached AI output. What is deliberately kept is the credential set (password hash, SSO binding, second-factor secret and enrolment, trusted-device state) and the interface preferences (timezone, locale, units, time and date format, glucose unit), because those are about the account rather than the record.\n\n" +
        "The model list is not written at the route. It is declared once in the wipe plan and held against the Prisma schema by a completeness test, which exists because this endpoint once deleted thirteen tables out of eighty-odd while telling people it had deleted everything.\n\n" +
        "One transaction, with a two-minute budget: a half-applied wipe is worse than none, because the person is told it succeeded either way. Every cached payload for the account is evicted afterwards so no surface serves pre-wipe data.\n\n" +
        "Gated like account deletion: the typed confirmation, plus a fresh factor proof for an MFA-enrolled account — on a cookie session the second factor completed within the last five minutes, on a Bearer token a single-use `X-Step-Up` elevation minted at `POST /api/auth/step-up` against a `totp`, `webauthn`, or `passkey` proof. The confirmation string is `DELETE`, NOT the `DELETE_ACCOUNT` that route wants.\n\n" +
        "One audit row survives the wipe that clears the rest of the audit history: it is written after the transaction commits, as the receipt for the erasure the person asked for.\n\n" +
        "A Bearer client should expect to be signed out by its own request: API tokens are on the wipe list, so the token that called this — and any step-up elevation minted from it — is removed along with the record. Sign in again rather than retrying with the same credential.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: dataWipeRequest } },
      },
      responses: {
        "200": {
          description:
            "Record erased. The counts say what was actually removed.",
          content: {
            "application/json": {
              schema: dataEnvelope(dataWipeResponse, "DataWipeEnvelope"),
            },
          },
        },
        "409": {
          description:
            "The caller is the last Guardian of a managed profile (`meta.errorCode` = `managed_profile.guardian.required`). Nothing was deleted — the managed records are locked for the whole transaction, so the refusal is atomic rather than partial. Add another Guardian, or delete the managed profile, first.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "Request body exceeds 65536 bytes. Nothing was deleted.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "401": {
          description:
            "Not authenticated — or the account has a second factor and the caller carries no proof of it fresh enough for a destructive action (`meta.errorCode` = `auth.stepup.required`, or `auth.stepup.mfa_not_enrolled`). A Bearer caller clears it with an `X-Step-Up` elevation from `POST /api/auth/step-up`; the same code covers an elevation that is unknown, expired, already spent, bound to another token, or minted from too weak a factor.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "403": {
          description:
            "The Bearer token carries a narrow scope. Erasure needs a cookie session or a full-access token; the refusal happens before any second-factor proof is looked at.\n\n" +
            SHARING_NOT_PERMITTED_DESCRIPTION,
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/settings/privacy-summary": {
    get: {
      tags: ["Meta"],
      summary: "Read the retention and encryption facts",
      description:
        "What the Data & Privacy dashboard states, computed server-side so the page cannot claim a retention window the purge job does not enforce or an encryption count the registry does not back. Identical for every account on the instance; carries no key material and no per-row data.",
      responses: {
        "200": {
          description: "Retention windows and the encryption-at-rest summary.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                privacySummaryResponse,
                "PrivacySummaryEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};

/**
 * OpenAPI route table — admin invites + notification diagnostics.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import { inviteCreateSchema } from "@/lib/validations/invite";
import { adminReminderCheckSchema } from "@/lib/validations/notifications";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

// v1.4.48 H-APNs-1 — admin diagnostic endpoint for the notification
// subsystem. Mirrors the runtime types in
// `src/app/api/admin/notifications/diagnostic/route.ts`: APNs tokens
// are surfaced only as 8-char hex prefix + suffix (never the full
// token), per-channel `enabled` + `configPresent` booleans, and a
// `recentPushAttempts` array reserved for the v1.4.48+ follow-up that
// adds the dedicated PushAttempt table (currently always `[]` so the
// shape stays stable for iOS consumers).
const adminDiagnosticDevice = z
  .object({
    id: z.string(),
    platform: z.string(),
    hasApnsToken: z.boolean(),
    apnsTokenPrefix: z.string().nullable(),
    apnsTokenSuffix: z.string().nullable(),
    apnsEnvironment: z.string().nullable(),
    lastSeenAt: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "AdminDiagnosticDevice",
    description:
      "Per-device APNs registration snapshot. The APNs token is masked to its 8-char hex prefix + 8-char suffix so an operator can correlate with iOS-side logs without disclosing the delivery target.",
  });

const adminDiagnosticChannel = z
  .object({
    type: z.string(),
    enabled: z.boolean(),
    configPresent: z.boolean(),
  })
  .meta({
    id: "AdminDiagnosticChannel",
    description:
      "Per-channel state. `configPresent` is true when the channel's encrypted-JSON config blob carries the field the corresponding sender will read (chatId+botToken for TELEGRAM, topic for NTFY); WEB_PUSH/APNS rely on sibling tables so the row's existence is the signal.",
  });

const adminDiagnosticPushAttempt = z
  .object({
    eventType: z.string(),
    channel: z.string(),
    result: z.string(),
    reason: z.string().nullable(),
    at: z.iso.datetime({ offset: true }),
  })
  .meta({
    id: "AdminDiagnosticPushAttempt",
    description:
      "Single push delivery attempt. Reserved for the v1.4.48+ follow-up that adds the dedicated PushAttempt table — currently always returned as an empty array so the response shape stays stable for iOS consumers.",
  });

const adminDiagnosticData = z
  .object({
    devices: z.array(adminDiagnosticDevice),
    notificationChannels: z.array(adminDiagnosticChannel),
    recentPushAttempts: z.array(adminDiagnosticPushAttempt),
  })
  .meta({
    id: "AdminDiagnosticData",
    description:
      "Admin notification diagnostic snapshot for the calling user — what the dispatcher would see when targeting this account. Surfaces device tokens (masked), channel state, and recent push attempts so an operator can debug an iOS / Web Push / Telegram / ntfy issue without DB shell access.",
  });

export const adminInvitePaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/admin/invites": {
    get: {
      tags: ["Admin"],
      summary: "List registration invites",
      description:
        "v1.16.0 — every invite with creator / consumer usernames, use counters, soft-revocation timestamp, and the full per-signup redemption ledger (`redemptions`; `consumer` only carries the LAST account on a multi-use invite). Metadata only — the raw token is never derivable from this endpoint (only its HMAC hash is persisted). Admin session cookie required; Bearer tokens cannot reach admin endpoints.",
      responses: {
        "200": {
          description: "All invites, newest first.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.array(
                  z.object({
                    id: z.string(),
                    createdAt: z.iso.datetime({ offset: true }),
                    expiresAt: z.iso.datetime({ offset: true }),
                    usedAt: z.iso.datetime({ offset: true }).nullable(),
                    revokedAt: z.iso.datetime({ offset: true }).nullable(),
                    uses: z.number().int(),
                    maxUses: z.number().int(),
                    creator: z
                      .object({ id: z.string(), username: z.string() })
                      .nullable(),
                    consumer: z
                      .object({ id: z.string(), username: z.string() })
                      .nullable(),
                    redemptions: z.array(
                      z.object({
                        id: z.string(),
                        redeemedAt: z.iso.datetime({ offset: true }),
                        user: z
                          .object({
                            id: z.string(),
                            username: z.string(),
                            email: z.string().nullable(),
                          })
                          .nullable(),
                      }),
                    ),
                  }),
                ),
                "AdminInviteList",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
    post: {
      tags: ["Admin"],
      summary: "Mint a registration invite",
      description:
        "v1.15.20 — creates an invite that admits a signup even while open registration is disabled. The raw `hlv_<64hex>` token and the composed registration URL appear EXACTLY ONCE in this response; only the keyed hash is persisted. Lifetime is capped at 30 days; `maxUses` makes multi-use invites possible (consumption is an atomic guarded increment). Admin session cookie required.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: inviteCreateSchema } },
      },
      responses: {
        "201": {
          description: "The minted invite, including the one-time raw token.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  id: z.string(),
                  createdAt: z.iso.datetime({ offset: true }),
                  expiresAt: z.iso.datetime({ offset: true }),
                  uses: z.number().int(),
                  maxUses: z.number().int(),
                  token: z
                    .string()
                    .describe(
                      "Raw invite token (`hlv_<64hex>`). Shown exactly once — never persisted in plaintext.",
                    ),
                  url: z
                    .string()
                    .describe(
                      "Composed invite universal-link (`/invite/<hlv_token>`). On iOS it opens the app onto onboarding registration; in a browser it redirects to `/auth/register?invite=…`.",
                    ),
                }),
                "AdminInviteCreated",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/admin/invites/{id}": {
    delete: {
      tags: ["Admin"],
      requestParams: { path: z.object({ id: z.string() }) },
      summary: "Revoke a registration invite",
      description:
        "v1.16.0 — soft-revokes the invite (`revokedAt`): the row keeps its redemption history visible in the admin table while the consume path refuses the link like an expired one. Idempotent: an unknown or already-revoked id returns `{ revoked: false }` instead of 404. Admin session cookie required.",
      responses: {
        "200": {
          description:
            "The invite was revoked (`revoked: true`) or nothing matched (`revoked: false`).",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ revoked: z.boolean() }),
                "AdminInviteRevoked",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
};

const adminReminderSchedule = z
  .object({
    window: z.string(),
    days: z.string(),
    status: z.enum(["open", "late", "threshold", "missed", "skipped"]),
    label: z.string(),
    minutesPastEnd: z.number().int().nullable(),
    notificationSent: z.boolean(),
  })
  .meta({
    id: "AdminReminderScheduleStatus",
    description:
      "One dose window as the sweep classified it against the OWNING account's wall clock, and whether this run dispatched for it. `notificationSent` is false for a window that is still open, for a day the schedule does not cover, and for a slot that already has an intake event today.",
  });

const adminReminderMedication = z
  .object({
    name: z.string(),
    dose: z.string(),
    user: z.string(),
    timezone: z.string(),
    localTime: z.string(),
    dayOfWeek: z.string(),
    notificationsEnabled: z.boolean(),
    schedules: z.array(adminReminderSchedule),
    eventsToday: z.number().int(),
  })
  .meta({
    id: "AdminReminderMedication",
    description:
      "One active medication the sweep walked, with the account it belongs to and that account's local clock — the sweep classifies every window against the owner's timezone, never the operator's.",
  });

const adminReminderCheckResult = z
  .object({
    timestamp: z.iso.datetime({ offset: true }),
    missedThresholdMinutes: z.number().int(),
    scoped: z
      .boolean()
      .describe(
        "True when the request named a `userId` and the sweep therefore walked one account only.",
      ),
    medications: z.array(adminReminderMedication),
    notificationsSent: z.number().int(),
    message: z.string(),
  })
  .meta({
    id: "AdminReminderCheckResult",
    description:
      "What the sweep found and what it sent. `notificationsSent` counts DISPATCHES, not deliveries — each one enters the channel cascade and the per-channel verdict lands in the `push_attempts` ledger the notification diagnostic surfaces.",
  });

export const adminDiagnosticPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/admin/notifications/reminder-check": {
    post: {
      tags: ["Admin"],
      summary: "Run the medication-reminder sweep",
      description:
        "The admin panel's manual reminder sweep: it classifies every active medication's dose windows against the OWNING account's wall clock and dispatches a MEDICATION_REMINDER for each overdue slot that has no intake event today. Cookie auth only — `requireAdmin()` refuses every Bearer caller, wildcard scope included.\n\nScope is the thing to get right. With no body the sweep is INSTANCE-WIDE and dispatches into every account that has an overdue dose and a configured channel; that is the operator button's behaviour and it is deliberate. A caller that means to sweep one account sends `userId` and stops being a second writer for every other one. The selector can only narrow: it feeds the Prisma `where`, never the authorisation.",
      requestBody: {
        required: false,
        content: {
          "application/json": { schema: adminReminderCheckSchema },
        },
      },
      responses: {
        "200": {
          description: "The sweep's findings and how many reminders it sent.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                adminReminderCheckResult,
                "AdminReminderCheckResponse",
              ),
            },
          },
        },
        "403": {
          description: "Caller is not an admin.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/admin/notifications/diagnostic": {
    get: {
      tags: ["Admin"],
      summary: "Admin notification diagnostic snapshot",
      description:
        "Admin-only. Returns what the dispatcher would see when targeting the calling admin's account: registered devices (APNs tokens masked to prefix + suffix), per-channel enabled + configPresent flags, and recent push attempts (currently always `[]` pending the v1.4.48+ PushAttempt table). Cookie auth only — never Bearer.",
      responses: {
        "200": {
          description: "Diagnostic snapshot.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                adminDiagnosticData,
                "AdminDiagnosticResponse",
              ),
            },
          },
        },
        "403": {
          description: "Caller is not an admin.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
};

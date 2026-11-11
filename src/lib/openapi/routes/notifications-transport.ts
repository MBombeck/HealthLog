/**
 * OpenAPI route table — notification transport: the VAPID key a client needs
 * to subscribe, the Web Push subscription lifecycle, and the per-channel
 * self-tests.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. Kept separate
 * from `./notifications.ts` — which owns per-event preferences and per-channel
 * delivery health — because the two answer different questions: that module
 * describes what gets sent and whether it arrived, this one the plumbing a
 * client sets up and then verifies.
 *
 * Schemas come from `src/lib/validations/notifications.ts` where shared with
 * the runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import { webPushSubscriptionSchema } from "@/lib/validations/notifications";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

const vapidPublicKeyResponse = z
  .object({
    publicKey: z
      .string()
      .describe(
        "The instance's VAPID public key, base64url. Public by definition — it is what a browser passes to `pushManager.subscribe`. The private half never leaves the server.",
      ),
  })
  .meta({ id: "VapidPublicKeyResponse" });

const webPushSubscribeRequest = webPushSubscriptionSchema.meta({
  id: "WebPushSubscribeRequest",
  description:
    "A browser Push subscription, exactly as `PushSubscription.toJSON()` produces it. `endpoint` must be HTTPS and must resolve to a public host — the push library dials it later with its own fetch that bypasses the shared egress wrapper, so the SSRF floor is enforced here at input time and again at send time. The `p256dh` and `auth` keys are stored encrypted at rest.",
});

const webPushUnsubscribeRequest = z
  .object({
    endpoint: z.url().describe("The endpoint of the subscription to forget."),
  })
  .meta({
    id: "WebPushUnsubscribeRequest",
    description:
      "Identifies a subscription to remove. Scoped to the caller, so an endpoint belonging to another account matches nothing.",
  });

/**
 * The self-test result shape shared by the APNs and Web Push tests.
 *
 * Both report failure inside a 200 rather than as an error status, and that is
 * the single most important thing about them: the request succeeded, the PUSH
 * did not. A client that branches on HTTP status alone will tell the person
 * their notifications work when they do not.
 */
const apnsTestResponse = z
  .object({
    ok: z.boolean().describe("Whether the push was accepted by APNs."),
    reason: z
      .string()
      .optional()
      .describe(
        "Why it was not, when `ok` is false. Absent on success. Comes from the dispatcher's own classification — an unregistered token, a configuration gap, no iOS device on the account.",
      ),
  })
  .meta({ id: "ApnsTestResponse" });

const webPushTestResponse = z
  .object({
    ok: z
      .boolean()
      .describe(
        "Whether at least one of the account's subscriptions accepted the push.",
      ),
    latencyMs: z
      .number()
      .int()
      .optional()
      .describe("Time to send to every subscription. Present on success only."),
    reason: z
      .string()
      .optional()
      .describe(
        "Why it was not, when `ok` is false. Absent on success. The sender's own classification, the same code a failed reminder records (`web_push_410_gone` when every endpoint is gone, a status-derived code otherwise).",
      ),
  })
  .meta({ id: "WebPushTestResponse" });

export const notificationTransportPaths: NonNullable<
  ZodOpenApiObject["paths"]
> = {
  "/api/notifications/vapid": {
    get: {
      // No credential: this operation is reachable before one exists.
      // The document-level default offers the Bearer token and the session
      // cookie as alternatives; an empty array is how OpenAPI says neither
      // is required. The list of paths allowed to say it lives in
      // `openapi-security-declaration-guard.test.ts`.
      security: [],
      tags: ["Notifications"],
      summary: "Read the instance's VAPID public key",
      description:
        "What a browser needs before it can create a Push subscription. Anonymous — the key is public by construction and discloses nothing about any account. Takes no parameters.",
      responses: {
        "200": {
          description: "The VAPID public key.",
          content: {
            "application/json": {
              schema: dataEnvelope(vapidPublicKeyResponse, "VapidEnvelope"),
            },
          },
        },
        "503": {
          description:
            "The operator has configured no VAPID keys, so Web Push cannot be offered on this instance at all. Hide the subscribe control rather than retrying — this does not resolve on its own.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/notifications/web-push": {
    post: {
      tags: ["Notifications"],
      summary: "Register a Web Push subscription",
      description:
        "Stores a browser Push subscription for the caller and, on the first one, creates the account's Web Push notification channel enabled. Upsert by endpoint: re-posting the same endpoint refreshes its keys rather than duplicating the row, so a client can send this on every page load without checking first.\n\n" +
        "The subscription keys are encrypted at rest. The endpoint is validated as HTTPS and as a public host before anything is written — the push library dials it later through its own fetch, outside the shared egress wrapper, so input time is where that has to be caught.\n\n" +
        "Body capped at 64 KB. A rejected subscription answers the standard multi-issue 422, so a client can tell a non-HTTPS endpoint from an internal-host one from a missing key. The issue list carries `path`, `code` and `message` and never the rejected value — neither the endpoint nor the subscription keys are echoed back.\n\n" +
        "An operator can switch Web Push off for the whole instance. While that switch is off this answers 403 before it reads the body, and no subscription and no channel row are created. Read the switch from `GET /api/settings/global-services` and hide the subscribe control rather than retrying.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: webPushSubscribeRequest } },
      },
      responses: {
        "200": {
          description: "Subscription stored.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ subscribed: z.literal(true) }),
                "WebPushSubscribeEnvelope",
              ),
            },
          },
        },
        "403": {
          description:
            "The operator switched Web Push off for this instance. Nothing was stored.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "Request body exceeds 65536 bytes. Nothing was stored.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Notifications"],
      summary: "Forget a Web Push subscription",
      description:
        "Removes the caller's subscription for the given endpoint. Idempotent and silent about the outcome: an endpoint that was never stored, and one belonging to another account, both answer the same success — the response says nothing about how many rows matched, so it cannot be used to probe whether an endpoint exists.\n\n" +
        "The Web Push channel row is left in place; this removes a destination, not the channel. Body capped at 64 KB; a malformed `endpoint` answers the standard multi-issue 422, which does not echo the value.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: webPushUnsubscribeRequest } },
      },
      responses: {
        "200": {
          description:
            "The subscription is gone, or was never there. Indistinguishable by design.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ unsubscribed: z.literal(true) }),
                "WebPushUnsubscribeEnvelope",
              ),
            },
          },
        },
        "413": {
          description: "Request body exceeds 65536 bytes.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
  "/api/notifications/web-push/test": {
    post: {
      tags: ["Notifications"],
      summary: "Send a test push to every Web Push subscription",
      description:
        "Fires one notification to each of the caller's subscriptions, through the same sender real reminders use, with the text in the account's language. The device the test was pressed on gets it whichever subscription is newest. Endpoints the push service reports gone (404/410) are removed, as on a real send. Takes no body. Rate-limited 5 per minute per user.\n\n" +
        "Read `ok`, not the status. A push that every service rejects still answers 200, with `ok: false` and a `reason`. No endpoint is returned: the full endpoint is the routing secret for that subscription.",
      responses: {
        "200": {
          description:
            "The test ran. `ok` says whether the push was accepted; a false here is a real failure reported inside a success.",
          content: {
            "application/json": {
              schema: dataEnvelope(webPushTestResponse, "WebPushTestEnvelope"),
            },
          },
        },
        // Spread FIRST: both overrides below share a status with the generic
        // entries, and the generic one would otherwise win and drop the
        // errorCode a client branches on.
        ...stdResponses,
        "422": {
          description:
            "Nothing to test against: the account has no Push subscription (`meta.errorCode` = `not_configured`), or the operator has configured no VAPID keys (`vapid_not_configured`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description:
            "More than 5 tests in a minute (`meta.errorCode` = `rate_limited_self`). The code distinguishes the caller's own test budget from a shared limit.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/notifications/apns/test": {
    post: {
      tags: ["Notifications"],
      summary: "Send a test push to the account's iOS devices",
      description:
        "Fires one self-test through APNs to the caller's registered iOS devices. Takes no body. Rate-limited 5 per minute per user. Available to any authenticated user for their own account — the admin test endpoint is a different surface that fans out across every channel at once.\n\n" +
        "Sent as a medication reminder rather than a generic notification, deliberately: only that event type takes the time-sensitive, high-priority branch, and a test delivered at the default level can be summarised into Notification Center instead of appearing on the lock screen. Testing at the default level would leave a person unable to tell whether their real dose reminders will surface. The visible text still reads as a test so nobody mistakes it for a due dose, and it is rendered in the account's own interface language.\n\n" +
        "Read `ok`, not the status: a failed send answers 200 with `ok: false` and a `reason`.",
      responses: {
        "200": {
          description:
            "The test ran. `ok` says whether APNs accepted it; `reason` says why not.",
          content: {
            "application/json": {
              schema: dataEnvelope(apnsTestResponse, "ApnsTestEnvelope"),
            },
          },
        },
        ...stdResponses,
        "429": {
          description:
            "More than 5 tests in a minute (`meta.errorCode` = `rate_limited_self`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
};

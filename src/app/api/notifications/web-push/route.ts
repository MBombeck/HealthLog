import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { isChannelGloballyEnabled } from "@/lib/app-settings";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, apiError, returnAllZodIssues } from "@/lib/api-response";
import { encrypt } from "@/lib/crypto";
import { reEnableChannel } from "@/lib/notifications/channel-state";
import { webPushSubscriptionSchema } from "@/lib/validations/notifications";
import { z } from "zod/v4";

// The endpoint is later dialled by `web-push`, which does its own internal
// fetch that bypasses safeFetch — so the SSRF floor has to be enforced here
// at input time. `webPushSubscriptionSchema` requires https + isPublicUrl
// (blocks loopback/link-local/metadata/internal hosts). The sender applies
// the same check again at egress time as defence-in-depth.
const subscribeSchema = webPushSubscriptionSchema;

const unsubscribeSchema = z
  .object({
    endpoint: z.string().url(),
  })
  .strict();

/*
 * Both parses below answer with the multi-issue envelope, like every other
 * body-parsing route in the tree. They used to answer a flat
 * `apiError("Invalid data", 422)`, which made a non-HTTPS endpoint, an
 * endpoint pointing at an internal host, an over-long one and a missing
 * subscription key byte-identical to each other — a client could see that its
 * subscription was refused and had no way to learn which rule it broke.
 *
 * Echoing the issues is safe here, and it is worth writing down why rather
 * than leaving it to be re-derived. The endpoint is a routing secret and the
 * keys are subscription crypto material, so the refusal must not carry them
 * back. It does not: `sanitiseZodIssues` emits `path`, `code` and `message`
 * only — `issue.params`, which is where Zod keeps a rejected value, stays
 * server-side — and every message this schema can produce is a fixed string
 * or a length/format default. None of them interpolates the value.
 */

/**
 * POST /api/notifications/web-push
 * Save a Web Push subscription for the current user.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "notifications.web-push.subscribe" } });

  // Subscribing IS the enable step for this channel — it creates the
  // WEB_PUSH `NotificationChannel` row. An operator who switched Web Push
  // off instance-wide (`AppSettings.webPushGlobal`) gets a refusal that says
  // so rather than a subscription that stores fine and delivers nothing.
  if (!(await isChannelGloballyEnabled("WEB_PUSH"))) {
    annotate({ meta: { refused: "globally_disabled" } });
    return apiError(
      "Web Push is disabled on this instance by the operator",
      403,
    );
  }

  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > 64 * 1024) {
      return apiError(`Request body exceeds ${64 * 1024} bytes`, 413);
    }
    body = JSON.parse(raw);
  } catch {
    return apiError("Invalid JSON data", 422);
  }

  const parsed = subscribeSchema.safeParse(body);
  if (!parsed.success) return returnAllZodIssues(parsed.error, 422);

  const { endpoint, keys } = parsed.data;
  const userAgent = request.headers.get("user-agent") ?? undefined;

  // Upsert subscription (encrypt sensitive keys)
  await prisma.pushSubscription.upsert({
    where: {
      userId_endpoint: {
        userId: user.id,
        endpoint,
      },
    },
    create: {
      userId: user.id,
      endpoint,
      p256dh: encrypt(keys.p256dh),
      auth: encrypt(keys.auth),
      userAgent,
    },
    update: {
      p256dh: encrypt(keys.p256dh),
      auth: encrypt(keys.auth),
      userAgent,
    },
  });

  // Ensure an enabled WEB_PUSH channel. A channel switched off because the
  // last browser's endpoint died (410) or failed five times stays off until
  // something turns it back on, and a new subscription is exactly that.
  const existingChannel = await prisma.notificationChannel.findFirst({
    where: { userId: user.id, type: "WEB_PUSH" },
  });

  if (!existingChannel) {
    await prisma.notificationChannel.create({
      data: {
        userId: user.id,
        type: "WEB_PUSH",
        enabled: true,
        config: encrypt(JSON.stringify({})),
      },
    });
  } else if (!existingChannel.enabled) {
    await reEnableChannel({
      id: existingChannel.id,
      userId: existingChannel.userId,
      type: "WEB_PUSH",
    });
  }

  return apiSuccess({ subscribed: true });
});

/**
 * DELETE /api/notifications/web-push
 * Remove a Web Push subscription.
 */
export const DELETE = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "notifications.web-push.unsubscribe" } });

  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > 64 * 1024) {
      return apiError(`Request body exceeds ${64 * 1024} bytes`, 413);
    }
    body = JSON.parse(raw);
  } catch {
    return apiError("Invalid JSON data", 422);
  }

  const parsed = unsubscribeSchema.safeParse(body);
  if (!parsed.success) return returnAllZodIssues(parsed.error, 422);

  await prisma.pushSubscription.deleteMany({
    where: {
      userId: user.id,
      endpoint: parsed.data.endpoint,
    },
  });

  return apiSuccess({ unsubscribed: true });
});

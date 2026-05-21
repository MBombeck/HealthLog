import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-response";
import { moodLogWebhookPayloadSchema } from "@/lib/validations/moodlog";
import { readMoodLogSecret } from "@/lib/moodlog-secret";
import { apiHandler } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { recomputeMoodBucketsForEntry } from "@/lib/rollups/mood-rollups";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "moodlog.webhook" } });

  // 1. Rate limit (30/min per IP)
  const ip = getClientIp(request) ?? "unknown";
  const rl = await checkRateLimit(`moodlog-webhook:${ip}`, 30, 60_000);
  if (!rl.allowed) {
    return apiError("Rate limit exceeded", 429);
  }

  // 2. Check global toggle
  const appSettings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: { moodLogGlobal: true },
  });
  if (appSettings && !appSettings.moodLogGlobal) {
    return apiError("moodLog integration is disabled", 403);
  }

  // 3. Get webhook secret from header
  const webhookSecret = request.headers.get("x-webhook-secret");
  if (!webhookSecret) {
    return apiError("Missing X-Webhook-Secret header", 401);
  }

  // 4. Find all enabled users with webhook secrets and compare timing-safe
  const candidates = await prisma.user.findMany({
    where: {
      moodLogEnabled: true,
      moodLogWebhookSecret: { not: null },
    },
    select: { id: true, moodLogWebhookSecret: true },
  });

  // V3 audit STILL-V2-C-2: stored secret is now encrypted at rest. Decrypt
  // each candidate before the timing-safe compare. `readMoodLogSecret`
  // also tolerates legacy plaintext rows during the transition window.
  const receivedBuf = Buffer.from(webhookSecret, "utf8");
  const user = candidates.find((c) => {
    const expected = readMoodLogSecret(c.moodLogWebhookSecret);
    if (!expected) return false;
    const expectedBuf = Buffer.from(expected, "utf8");
    if (expectedBuf.length !== receivedBuf.length) return false;
    return timingSafeEqual(expectedBuf, receivedBuf);
  });

  if (!user) {
    return apiError("Invalid webhook secret", 401);
  }

  getEvent()?.setAuth({ user_id: user.id, auth_method: "webhook_secret" });

  // 5. Parse body
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError("Invalid JSON", 400);
  }

  // Handle test pings from moodLog's "Test senden" button
  if (body.event === "webhook.test") {
    annotate({ meta: { webhook_event: "webhook.test" } });
    return new Response(null, { status: 200 });
  }

  const parsed = moodLogWebhookPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid payload", 400);
  }

  const { event, entry } = parsed.data;
  annotate({ meta: { webhook_event: event } });

  // 5. Process event (non-blocking — fire and forget with error logging)
  const moodLoggedAt = new Date(entry.time);

  try {
    if (event === "mood.deleted") {
      await prisma.moodEntry.deleteMany({
        where: {
          userId: user.id,
          date: entry.date,
          moodLoggedAt,
        },
      });
    } else {
      // mood.created or mood.updated
      await prisma.moodEntry.upsert({
        where: {
          userId_date_moodLoggedAt: {
            userId: user.id,
            date: entry.date,
            moodLoggedAt,
          },
        },
        update: {
          mood: entry.mood,
          score: entry.score,
          tags: entry.tags ? JSON.stringify(entry.tags) : null,
          source: "MOODLOG",
        },
        create: {
          userId: user.id,
          date: entry.date,
          mood: entry.mood,
          score: entry.score,
          tags: entry.tags ? JSON.stringify(entry.tags) : null,
          source: "MOODLOG",
          moodLoggedAt,
        },
      });
    }

    // v1.4.39 W-MOOD — refresh the persisted rollup for the entry's
    // bucket. Inline best-effort: a failure here must not block the
    // webhook 200 response (the rollup is a cache tier, the source-of-
    // truth is the mood_entries write that already committed).
    try {
      await recomputeMoodBucketsForEntry(user.id, moodLoggedAt);
    } catch (rollupErr) {
      getEvent()?.addWarning(
        "Mood rollup recompute failed: " +
          (rollupErr instanceof Error ? rollupErr.message : String(rollupErr)),
      );
    }
  } catch (err) {
    getEvent()?.addWarning("DB operation failed: " + err);
  }

  // 6. Return 200 immediately
  return new Response(null, { status: 200 });
});

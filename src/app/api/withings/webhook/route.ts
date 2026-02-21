import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { syncUserMeasurements } from "@/lib/withings/sync";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-response";
import { NextRequest, NextResponse } from "next/server";

function hasValidWebhookSecret(request: NextRequest): boolean {
  const expected = process.env.WITHINGS_WEBHOOK_SECRET;
  if (!expected) {
    console.error(
      "[withings] WITHINGS_WEBHOOK_SECRET not configured — rejecting webhook",
    );
    return false;
  }
  const received = request.nextUrl.searchParams.get("secret");
  if (!received) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Withings webhook notification endpoint.
 * Withings sends a POST when new measurements are available.
 * The webhook sends: userid, startdate, enddate, appli
 */
export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  const rl = checkRateLimit(`withings-webhook:${ip}`, 30, 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { status: "rate_limited" },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  if (!hasValidWebhookSecret(request)) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 });
  }

  try {
    // Withings sends form-encoded or JSON depending on version
    const contentType = request.headers.get("content-type") ?? "";
    let withingsUserId: string | null = null;

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await request.formData();
      withingsUserId = formData.get("userid") as string;
    } else {
      const body = await request.json();
      withingsUserId = body.userid?.toString() ?? null;
    }

    if (!withingsUserId) {
      return NextResponse.json({ status: "ignored" }, { status: 200 });
    }

    // Find user by Withings user ID
    const connection = await prisma.withingsConnection.findFirst({
      where: { withingsUserId },
    });

    if (!connection) {
      console.warn(
        `[withings] Webhook for unknown withings user: ${withingsUserId}`,
      );
      return NextResponse.json({ status: "unknown_user" }, { status: 200 });
    }

    // Sync measurements (non-blocking response for Withings)
    syncUserMeasurements(connection.userId).catch((err) => {
      console.error(
        `[withings] Sync failed for user ${connection.userId}:`,
        err,
      );
    });

    return NextResponse.json({ status: "ok" }, { status: 200 });
  } catch (err) {
    console.error("[withings] Webhook error:", err);
    // Always return 200 to avoid Withings retries for our errors
    return NextResponse.json({ status: "error" }, { status: 200 });
  }
}

/**
 * Withings sends a HEAD request to verify the webhook URL.
 */
export async function HEAD(request: NextRequest) {
  if (!hasValidWebhookSecret(request)) {
    return new NextResponse(null, { status: 401 });
  }
  return new NextResponse(null, { status: 200 });
}

export async function GET(request: NextRequest) {
  if (!hasValidWebhookSecret(request)) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ status: "ok" }, { status: 200 });
}

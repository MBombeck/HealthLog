import { prisma } from "@/lib/db";
import { syncUserMeasurements } from "@/lib/withings/sync";
import { NextRequest, NextResponse } from "next/server";

function hasValidWebhookSecret(request: NextRequest): boolean {
  const expected = process.env.WITHINGS_WEBHOOK_SECRET;
  if (!expected) return true;
  return request.nextUrl.searchParams.get("secret") === expected;
}

/**
 * Withings webhook notification endpoint.
 * Withings sends a POST when new measurements are available.
 * The webhook sends: userid, startdate, enddate, appli
 */
export async function POST(request: NextRequest) {
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

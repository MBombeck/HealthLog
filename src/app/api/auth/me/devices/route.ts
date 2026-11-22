/**
 * GET /api/auth/me/devices
 *
 * v1.4.23 — list active devices for the current user. Drives the
 * settings → security → devices surface in the v1.5 iOS app and the
 * matching web view planned for a follow-up. The list ships
 * device-identifying metadata only (label, lastSeen, channels) — no
 * tokens, no APNs identifiers, no IPs.
 *
 * v1.4.23 — the "current device" marker is no
 * longer derived from the unauthenticated `X-Device-Id` request header
 * alone. The header value is now cross-checked against an unrevoked
 * RefreshToken row owned by the authenticated user; only when both
 * agree do we mark the matching row with `isCurrent: true`. This stops
 * a forged `X-Device-Id` header from flipping the badge for a device
 * the caller doesn't actually hold a credential for. Browser callers
 * (cookie sessions, no refresh-token row) continue to see
 * `isCurrent: false` across the board — there is no server-side anchor
 * to validate the header against.
 */
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";

interface DeviceDTO {
  id: string;
  label: string;
  platform: string;
  appVersion: string | null;
  locale: string | null;
  channels: Array<"web_push" | "apns">;
  lastSeenAt: string;
  createdAt: string;
  isCurrent: boolean;
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  const headerDeviceId = request.headers.get("x-device-id");

  // Anchor `isCurrent` against a server-trusted credential.
  // The header is only honoured when the user actually holds a live
  // refresh-token issued for that device. Otherwise, ignore it.
  let trustedCurrentDeviceId: string | null = null;
  if (headerDeviceId) {
    const tokenForDevice = await prisma.refreshToken.findFirst({
      where: {
        userId: user.id,
        deviceId: headerDeviceId,
        revokedAt: null,
      },
      select: { id: true },
    });
    if (tokenForDevice) trustedCurrentDeviceId = headerDeviceId;
  }

  const devices = await prisma.device.findMany({
    where: { userId: user.id },
    orderBy: { lastSeen: "desc" },
  });

  const result: DeviceDTO[] = devices.map((d) => {
    const channels: DeviceDTO["channels"] = [];
    // The legacy `token` column always carries the generic device
    // identifier — for v1.4.23 it doubles as the web-push channel
    // anchor when a VAPID subscription exists.
    if (d.token) channels.push("web_push");
    if (d.apnsToken) channels.push("apns");
    return {
      id: d.id,
      // Prefer the `model` field as the label; fall back to bundleId or
      // a generic platform string so the row never paints blank.
      label: d.model ?? d.bundleId ?? d.platform,
      platform: d.platform,
      appVersion: d.appVersion,
      locale: d.locale,
      channels,
      lastSeenAt: d.lastSeen.toISOString(),
      createdAt: d.createdAt.toISOString(),
      // The header and `RefreshToken.deviceId` carry the device's `token`
      // (what the app registers), not the row id.
      isCurrent:
        trustedCurrentDeviceId !== null && d.token === trustedCurrentDeviceId,
    };
  });

  annotate({
    action: { name: "auth.me.devices.list" },
    meta: { device_count: result.length },
  });

  return apiSuccess({ devices: result });
});

import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { decrypt } from "@/lib/crypto";
import type { ChannelType } from "@/lib/notifications/types";
import {
  DIAGNOSTIC_DEVICE_SELECT,
  diagnosticDevice,
  diagnosticPushAttempt,
  type DiagnosticDevice,
  type DiagnosticPushAttempt,
} from "@/lib/push-relay/diagnostics";

export const dynamic = "force-dynamic";

/**
 * v1.4.48 — admin-only diagnostic endpoint for the
 * notification subsystem. Surfaces what the dispatcher would see when
 * targeting the calling admin's account so an operator can debug an
 * iOS / Web Push / Telegram / ntfy issue without needing DB shell
 * access. This fills the gap that bottlenecked the v1.4.47 APNs hunt
 * — every "is the token there?" / "is the channel enabled?" question
 * was a Coolify exec round-trip.
 *
 * Response shape:
 *   {
 *     devices: Device[],              — APNs token presence + masked
 *                                       prefix/suffix only; never the
 *                                       full token.
 *     notificationChannels: Channel[] — per-channel enabled + whether
 *                                       the channel-specific config
 *                                       blob is present.
 *     recentPushAttempts: PushAttempt[] — last 20 push deliveries for
 *                                         the calling user, ordered by
 *                                         recency. Backed by the
 *                                         `push_attempts` table — every
 *                                         sender (APNS, WEB_PUSH,
 *                                         TELEGRAM, NTFY) writes one
 *                                         fire-and-forget row per
 *                                         dispatch. v1.4.49 closed the
 *                                         empty-array stub by adding
 *                                         the table + the write path.
 *   }
 *
 * Security: admin-only (cookie auth, never Bearer). The route never
 * returns the full APNs token — only an 8-char hex prefix + 8-char
 * suffix so the operator can correlate with iOS-side diagnostics. The
 * device and attempt shapes and the mask come from
 * `src/lib/push-relay/diagnostics.ts`, which the device's own read
 * (`GET /api/devices/me/push-diagnostics`) shares.
 */

interface DiagnosticChannel {
  type: ChannelType | string;
  enabled: boolean;
  configPresent: boolean;
}

interface DiagnosticPayload {
  devices: DiagnosticDevice[];
  notificationChannels: DiagnosticChannel[];
  recentPushAttempts: DiagnosticPushAttempt[];
}

/**
 * Decide whether the channel's encrypted-JSON config blob carries the
 * key the corresponding sender will actually read. We decrypt + parse
 * inside a try/catch so a corrupted ciphertext row (or an upstream
 * encryption-key rotation) cannot 500 the diagnostic endpoint — the
 * worst case is `configPresent: false` and the operator investigates
 * why the row is unreadable.
 *
 * The required field per channel type:
 *   - TELEGRAM → `chatId` + `botToken`
 *   - NTFY     → `topic`
 *   - WEB_PUSH → no per-channel blob (subscriptions live in the
 *                `push_subscriptions` table); treat the row's mere
 *                existence as `configPresent: true`.
 *   - APNS     → no per-channel blob (device tokens live on the
 *                `devices` table); treat the row's mere existence as
 *                `configPresent: true`.
 */
function isChannelConfigPresent(
  type: string,
  encryptedConfig: string,
): boolean {
  if (type === "WEB_PUSH" || type === "APNS") {
    // These channels store their delivery target on sibling tables
    // (`push_subscriptions` / `devices`), not in the channel-row
    // config blob. The row's existence is the signal.
    return true;
  }
  try {
    const parsed = JSON.parse(decrypt(encryptedConfig)) as Record<
      string,
      unknown
    >;
    if (type === "TELEGRAM") {
      return (
        typeof parsed.chatId === "string" &&
        parsed.chatId.length > 0 &&
        typeof parsed.botToken === "string" &&
        parsed.botToken.length > 0
      );
    }
    if (type === "NTFY") {
      return typeof parsed.topic === "string" && parsed.topic.length > 0;
    }
    if (type === "WEBHOOK") {
      return typeof parsed.url === "string" && parsed.url.length > 0;
    }
    if (type === "EMAIL") {
      return (
        typeof parsed.recipient === "string" && parsed.recipient.length > 0
      );
    }
    return false;
  } catch {
    return false;
  }
}

export const GET = apiHandler(async () => {
  const { user } = await requireAdmin();
  annotate({ action: { name: "admin.notifications.diagnostic" } });

  const [devices, channels, pushAttempts] = await Promise.all([
    prisma.device.findMany({
      where: { userId: user.id },
      select: DIAGNOSTIC_DEVICE_SELECT,
      orderBy: { lastSeen: "desc" },
    }),
    prisma.notificationChannel.findMany({
      where: { userId: user.id },
      select: { type: true, enabled: true, config: true },
    }),
    // Trailing delivery attempts for the calling account as recipient. The
    // recipient index keeps the bounded diagnostic read independent of the
    // account's lifetime notification volume.
    prisma.pushAttempt.findMany({
      where: {
        recipientUserId: user.id,
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        userId: true,
        recordUserId: true,
        recipientUserId: true,
        eventType: true,
        channel: true,
        result: true,
        reason: true,
        createdAt: true,
      },
    }),
  ]);

  const diagnosticDevices: DiagnosticDevice[] = devices.map(diagnosticDevice);

  const diagnosticChannels: DiagnosticChannel[] = channels.map((c) => ({
    type: c.type,
    enabled: c.enabled,
    configPresent: isChannelConfigPresent(c.type, c.config),
  }));

  // Backed by the `push_attempts` table; `createdAt` reads `at`.
  const recentPushAttempts: DiagnosticPushAttempt[] = pushAttempts.map(
    diagnosticPushAttempt,
  );

  const payload: DiagnosticPayload = {
    devices: diagnosticDevices,
    notificationChannels: diagnosticChannels,
    recentPushAttempts,
  };

  return apiSuccess(payload);
});

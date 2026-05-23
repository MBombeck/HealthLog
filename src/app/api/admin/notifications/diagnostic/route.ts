import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { decrypt } from "@/lib/crypto";
import type { ChannelType } from "@/lib/notifications/types";

export const dynamic = "force-dynamic";

/**
 * v1.4.48 H-APNs-1 — admin-only diagnostic endpoint for the
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
 *                                         the calling user. See
 *                                         comment below — HealthLog
 *                                         does not currently persist
 *                                         per-attempt push history, so
 *                                         this is `[]` until a
 *                                         dedicated table is added.
 *   }
 *
 * Security: admin-only (cookie auth, never Bearer). The route never
 * returns the full APNs token — only an 8-char hex prefix + 8-char
 * suffix so the operator can correlate with iOS-side diagnostics.
 */

interface DiagnosticDevice {
  id: string;
  platform: string;
  hasApnsToken: boolean;
  apnsTokenPrefix: string | null;
  apnsTokenSuffix: string | null;
  apnsEnvironment: string | null;
  lastSeenAt: string;
}

interface DiagnosticChannel {
  type: ChannelType | string;
  enabled: boolean;
  configPresent: boolean;
}

interface DiagnosticPushAttempt {
  eventType: string;
  channel: string;
  result: string;
  reason: string | null;
  at: string;
}

interface DiagnosticPayload {
  devices: DiagnosticDevice[];
  notificationChannels: DiagnosticChannel[];
  recentPushAttempts: DiagnosticPushAttempt[];
}

/**
 * Map an APNs hex token to its 8-char prefix + 8-char suffix. APNs
 * device tokens are 64-char hex strings; we surface 8 + 8 = 16 chars
 * total (25 % of the token), which is enough for the operator to
 * cross-check against an iOS-side log line without disclosing the
 * delivery target. Tokens shorter than 16 chars are treated as opaque
 * (prefix / suffix both null) — that shape never appears in
 * production, but defensive against partial inserts during testing.
 */
function maskApnsToken(
  token: string | null,
): { prefix: string | null; suffix: string | null } {
  if (!token || token.length < 16) return { prefix: null, suffix: null };
  return {
    prefix: token.slice(0, 8),
    suffix: token.slice(-8),
  };
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
    return false;
  } catch {
    return false;
  }
}

export const GET = apiHandler(async () => {
  const { user } = await requireAdmin();
  annotate({ action: { name: "admin.notifications.diagnostic" } });

  const [devices, channels] = await Promise.all([
    prisma.device.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        platform: true,
        apnsToken: true,
        apnsEnvironment: true,
        lastSeen: true,
      },
      orderBy: { lastSeen: "desc" },
    }),
    prisma.notificationChannel.findMany({
      where: { userId: user.id },
      select: { type: true, enabled: true, config: true },
    }),
  ]);

  const diagnosticDevices: DiagnosticDevice[] = devices.map((d) => {
    const { prefix, suffix } = maskApnsToken(d.apnsToken);
    return {
      id: d.id,
      platform: d.platform,
      hasApnsToken: d.apnsToken !== null && d.apnsToken !== "",
      apnsTokenPrefix: prefix,
      apnsTokenSuffix: suffix,
      apnsEnvironment: d.apnsEnvironment,
      lastSeenAt: d.lastSeen.toISOString(),
    };
  });

  const diagnosticChannels: DiagnosticChannel[] = channels.map((c) => ({
    type: c.type,
    enabled: c.enabled,
    configPresent: isChannelConfigPresent(c.type, c.config),
  }));

  // HealthLog does not currently persist per-attempt push delivery
  // history (no `PushAttempt` / equivalent table — Wide Events emit to
  // stdout via `emitIfSampled` and audit-log captures only
  // channel-state transitions, not individual sends). Surfacing the
  // last 20 attempts is a known v1.4.48+ follow-up; until then this
  // field is intentionally an empty array so the response shape stays
  // stable for iOS-side consumers.
  const recentPushAttempts: DiagnosticPushAttempt[] = [];

  const payload: DiagnosticPayload = {
    devices: diagnosticDevices,
    notificationChannels: diagnosticChannels,
    recentPushAttempts,
  };

  return apiSuccess(payload);
});

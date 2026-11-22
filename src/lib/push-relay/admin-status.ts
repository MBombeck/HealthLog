/**
 * What the admin card and the one-time admin notice read
 * (`GET /api/admin/push-relay`).
 */
import { prisma } from "@/lib/db";
import {
  relayConfig,
  relayDocumentUrls,
  RELAY_TERMS_VERSION,
} from "@/lib/push-relay/config";
import { relayHealth } from "@/lib/push-relay/capability";
import { loadRegistration } from "@/lib/push-relay/registration";

/** The id of the one-time notice that the relay option exists. */
export const RELAY_NOTICE_ID = "push_relay_available";
export const RELAY_DOCS_URL = "https://docs.healthlog.dev/guides/push-relay/";

/** How far back the usage counts reach. */
export const RELAY_USAGE_WINDOW_DAYS = 7;

/**
 * What this instance handed the relay in the window, from its own delivery
 * ledger (`push_relay_deliveries`): counts per outcome and the last failure,
 * aggregate only. Per-channel delivery across every channel, the relay's
 * pushes included, is the notification health card's (`push_attempts`).
 */
async function relayUsage(now: Date) {
  const since = new Date(
    now.getTime() - RELAY_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const [groups, lastFailure] = await Promise.all([
    prisma.pushRelayDelivery.groupBy({
      by: ["status"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.pushRelayDelivery.findFirst({
      where: {
        createdAt: { gte: since },
        status: { in: ["failed", "dropped"] },
      },
      orderBy: { createdAt: "desc" },
      select: { reason: true, createdAt: true },
    }),
  ]);
  const count = (status: string) =>
    groups.find((g) => g.status === status)?._count._all ?? 0;
  return {
    windowDays: RELAY_USAGE_WINDOW_DAYS,
    accepted: count("accepted"),
    pending: count("pending"),
    dropped: count("dropped"),
    failed: count("failed"),
    lastFailure: lastFailure
      ? {
          reason: lastFailure.reason,
          at: lastFailure.createdAt.toISOString(),
        }
      : null,
  };
}

export async function adminRelayStatus(userId: string, now = new Date()) {
  const config = relayConfig();
  const [row, admin, bound, consented, usage] = await Promise.all([
    config.available ? loadRegistration(config) : null,
    prisma.user.findUnique({
      where: { id: userId },
      select: { adminNoticesDismissed: true },
    }),
    prisma.device.count({ where: { relayState: "bound" } }),
    prisma.device.count({ where: { relayConsentAt: { not: null } } }),
    relayUsage(now),
  ]);
  const health = relayHealth(row);
  const docs = config.origin ? relayDocumentUrls(config.origin) : null;
  return {
    allowed: config.allowed,
    available: config.available,
    unavailableReason: config.unavailableReason,
    relayHost: config.host || null,
    offered: row !== null,
    state: health.state,
    since: health.since?.toISOString() ?? null,
    reason: health.reason,
    instanceId: row?.instanceId ?? null,
    tier: row?.tier ?? null,
    notice: row?.noticeId ? { id: row.noticeId, level: row.noticeLevel } : null,
    lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null,
    devices: { bound, consented },
    usage,
    termsVersion: RELAY_TERMS_VERSION,
    termsUrl: docs?.termsUrl ?? null,
    privacyUrl: docs?.privacyUrl ?? null,
    docsUrl: RELAY_DOCS_URL,
    // The one-time notice that the relay exists: shown while it may be
    // offered, is not offered yet, and this admin has not dismissed it. Once
    // it is on, "the option stays off until you turn it on" is no longer true.
    noticePending:
      config.allowed &&
      row === null &&
      !(admin?.adminNoticesDismissed ?? []).includes(RELAY_NOTICE_ID),
  };
}

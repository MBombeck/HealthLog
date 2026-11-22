/**
 * What the admin card and the relay question read
 * (`GET /api/admin/push-relay`).
 */
import { prisma } from "@/lib/db";
import { loadApnsConfig } from "@/lib/notifications/senders/apns";
import {
  relayConfig,
  relayDocumentUrls,
  RELAY_TERMS_VERSION,
} from "@/lib/push-relay/config";
import { relayHealth } from "@/lib/push-relay/capability";
import { loadRegistration } from "@/lib/push-relay/registration";
import {
  loadStoredRelayDecision,
  operatorDecisionOf,
} from "@/lib/push-relay/operator-decision";

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

export async function adminRelayStatus(now = new Date()) {
  const config = relayConfig();
  const [row, stored, bound, consented, usage, unbindsPending, held] =
    await Promise.all([
      config.available ? loadRegistration(config) : null,
      loadStoredRelayDecision(),
      prisma.device.count({ where: { relayState: "bound" } }),
      prisma.device.count({ where: { relayConsentAt: { not: null } } }),
      relayUsage(now),
      prisma.pushRelayUnbind.count(),
      prisma.pushRelayRegistration.findMany({
        where: { instanceId: { not: null } },
        select: { relayHost: true },
        orderBy: { relayHost: "asc" },
      }),
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
    // The terms text the operator accepted with the switch is older than the
    // current one: the card asks for the current text to be confirmed once.
    // The relay keeps running meanwhile; nothing waits on the answer.
    termsConfirmationNeeded:
      row !== null && row.termsVersion !== RELAY_TERMS_VERSION,
    // Unbinds owed to the relay (erased accounts, revoked devices) that it
    // has not confirmed yet (`unbind-queue.ts`).
    unbindsPending,
    // Relays this server is still registered with but cannot reach under
    // its current settings (`PUSH_RELAY_MODE=off`, a changed
    // `PUSH_RELAY_URL`): they keep the server's device bindings until it
    // leaves them.
    unreachableRegistrations: held
      .map((h) => h.relayHost)
      .filter((host) => !config.available || host !== config.host),
    termsUrl: docs?.termsUrl ?? null,
    privacyUrl: docs?.privacyUrl ?? null,
    docsUrl: RELAY_DOCS_URL,
    // The operator's one answer for the whole server, as `/api/auth/me`
    // publishes it (`push.relay.operatorDecision`): the relay question is
    // asked while it is `undecided`, and never again once it is `off`.
    operatorDecision: operatorDecisionOf({
      stored,
      offered: row !== null,
      available: config.available,
      apnsConfigured: loadApnsConfig() !== null,
    }),
  };
}

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
import {
  loadRegistration,
  type RegistrationRow,
} from "@/lib/push-relay/registration";
import { storedRelayStatus } from "@/lib/push-relay/relay-status";
import {
  loadStoredRelayDecision,
  operatorDecisionOf,
} from "@/lib/push-relay/operator-decision";

export const RELAY_DOCS_URL = "https://docs.healthlog.dev/guides/push-relay/";

/** How far back the usage counts reach. */
export const RELAY_USAGE_WINDOW_DAYS = 7;

/** How far back the hand-off time reaches. */
const RELAY_HANDOFF_WINDOW_HOURS = 24;

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

/**
 * How long a push took from being queued on this server until the relay
 * answered `accepted`, over the pushes accepted in the window: the median
 * and the 95th percentile in whole milliseconds, aggregate only. The relay
 * answers `accepted` once Apple accepted the push, so the time covers this
 * server's hand-off, the network and the relay's request to Apple.
 * `retried` counts the pushes that waited for at least one retry here, whose
 * time therefore includes this server's backoff.
 *
 * One aggregate over the ledger's accepted rows, which always answers with
 * one row; the percentiles are null when it counted none. The start of the
 * window is bound as a UTC string and cast to a zone-less timestamp, which
 * is what `accepted_at` is, so the comparison does not depend on the time
 * zone of the process or of the database session.
 */
async function relayHandoff(now: Date) {
  const since = new Date(
    now.getTime() - RELAY_HANDOFF_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const [row] = await prisma.$queryRaw<
    Array<{
      count: number;
      retried: number;
      p50: number | null;
      p95: number | null;
    }>
  >`
    SELECT count(*)::int AS "count",
           (count(*) FILTER (WHERE "attempts" > 0))::int AS "retried",
           percentile_cont(0.5) WITHIN GROUP (ORDER BY "ms") AS "p50",
           percentile_cont(0.95) WITHIN GROUP (ORDER BY "ms") AS "p95"
      FROM (
        SELECT "attempts",
               (extract(epoch FROM "accepted_at" - "created_at") * 1000)::double precision AS "ms"
          FROM "push_relay_deliveries"
         WHERE "status" = 'accepted'
           AND "accepted_at" >= ${since}::timestamp(3)
      ) AS "accepted"`;
  const whole = (ms: number | null) =>
    ms === null ? null : Math.round(Number(ms));
  return {
    windowHours: RELAY_HANDOFF_WINDOW_HOURS,
    count: row.count,
    p50Ms: whole(row.p50),
    p95Ms: whole(row.p95),
    retried: row.retried,
  };
}

/**
 * The hourly `GET /v1/status` (`relay-status.ts`): when it was asked, and
 * what the relay last answered about itself and this instance.
 */
function relayCheckOf(row: RegistrationRow | null) {
  const answer = storedRelayStatus(row?.relayStatus ?? null);
  if (!row?.statusCheckedAt && !answer) return null;
  return {
    checkedAt: row?.statusCheckedAt?.toISOString() ?? null,
    answeredAt: answer?.at ?? null,
    state: answer?.state ?? null,
    devices: answer?.devices ?? null,
  };
}

export async function adminRelayStatus(now = new Date()) {
  const config = relayConfig();
  const [row, stored, bound, consented, usage, handoff, unbindsPending, held] =
    await Promise.all([
      config.available ? loadRegistration(config) : null,
      loadStoredRelayDecision(),
      prisma.device.count({ where: { relayState: "bound" } }),
      prisma.device.count({ where: { relayConsentAt: { not: null } } }),
      relayUsage(now),
      relayHandoff(now),
      prisma.pushRelayUnbind.count(),
      prisma.pushRelayRegistration.findMany({
        where: { instanceId: { not: null } },
        select: { relayHost: true },
        orderBy: { relayHost: "asc" },
      }),
    ]);
  const health = relayHealth(row);
  const ownApnsKey = loadApnsConfig() !== null;
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
    handoff,
    relayCheck: relayCheckOf(row),
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
    // An APNs key of this server's own (`APNS_*`) is in use: `routeFor`
    // sends every push directly to Apple with it and never over the relay,
    // whatever the switch says. The card says so instead of offering a
    // switch that would change nothing.
    ownApnsKey,
    // The operator's one answer for the whole server, as `/api/auth/me`
    // publishes it (`push.relay.operatorDecision`): the relay question is
    // asked while it is `undecided`, and never again once it is `off`.
    operatorDecision: operatorDecisionOf({
      stored,
      offered: row !== null,
      registered: row?.instanceId != null,
      available: config.available,
      apnsConfigured: ownApnsKey,
    }),
  };
}

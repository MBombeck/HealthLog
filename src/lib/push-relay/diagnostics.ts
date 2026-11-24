/**
 * Push diagnostics: what the admin notification diagnostic
 * (`/api/admin/notifications/diagnostic`) and the calling device's own read
 * (`GET /api/devices/me/push-diagnostics`) show. Each value is computed here
 * once, so the two never disagree about a token's mask, an attempt's shape or
 * a device's budget.
 *
 * The device read holds only that device's state: its route (the rule the
 * send follows), its relay binding, its silent budget (`wakes.ts`), the sync
 * owed to it, the last delivery per kind, the last envelope receipt it posted
 * and its APNs token masked. Nothing about the account's other devices, no
 * token in clear, no notification content.
 *
 * The last delivery per kind comes from the ledger that knows this device:
 * - over the relay, the relay outbox (`push_relay_deliveries`), with the
 *   relay's answer and whether the device opened it;
 * - over this server's own APNs key, the silent ledger (`push_wakes`) for the
 *   silent sync and the wakes (`sent`), and the account's APNs delivery
 *   attempts (`push_attempts`) for the alert, but only while this device is
 *   the account's one APNs device: that ledger names no device, so with two
 *   of them an attempt could be the other one's. A Live Activity over this
 *   server's own key leaves no per-device record.
 */
import { prisma } from "@/lib/db";
import {
  CLIENT_MANAGED_APNS_EVENTS,
  localDeliveryUntil,
} from "@/lib/notifications/client-managed-apns";
import { loadApnsConfig } from "@/lib/notifications/senders/apns";
import {
  deviceRouteOf,
  intakeSyncOf,
  relayHealth,
  transportOf,
  type IntakeSyncState,
  type RelayHealth,
} from "@/lib/push-relay/capability";
import { relayConfig } from "@/lib/push-relay/config";
import { LA_START_EVENT } from "@/lib/push-relay/live-activity-settle";
import { relayStateAt } from "@/lib/push-relay/relay-state";
import { loadRegistration } from "@/lib/push-relay/registration";
import {
  ROUTABLE_DEVICE_SELECT,
  type DeviceRoute,
} from "@/lib/push-relay/route-device";
import {
  silentBudgetSummary,
  silentWindow,
  type SilentKind,
} from "@/lib/push-relay/wakes";

/**
 * An APNs hex token as its 8-char prefix and 8-char suffix (16 of 64 chars),
 * enough to match an iOS-side log line without disclosing the delivery
 * target. A token shorter than 16 chars is opaque (both null); that shape
 * never appears in production.
 */
export function maskApnsToken(token: string | null): {
  prefix: string | null;
  suffix: string | null;
} {
  if (!token || token.length < 16) return { prefix: null, suffix: null };
  return { prefix: token.slice(0, 8), suffix: token.slice(-8) };
}

/** One `push_attempts` row as the admin diagnostic lists it. */
export interface DiagnosticPushAttempt {
  recordUserId: string;
  recipientUserId: string;
  eventType: string;
  channel: string;
  result: string;
  reason: string | null;
  at: string;
}

export function diagnosticPushAttempt(row: {
  userId: string;
  recordUserId: string | null;
  recipientUserId: string | null;
  eventType: string;
  channel: string;
  result: string;
  reason: string | null;
  createdAt: Date;
}): DiagnosticPushAttempt {
  return {
    recordUserId: row.recordUserId ?? row.userId,
    recipientUserId: row.recipientUserId ?? row.userId,
    eventType: row.eventType,
    channel: row.channel,
    result: row.result,
    reason: row.reason,
    at: row.createdAt.toISOString(),
  };
}

/** One device as the admin diagnostic lists it. */
export interface DiagnosticDevice {
  id: string;
  platform: string;
  hasApnsToken: boolean;
  apnsTokenPrefix: string | null;
  apnsTokenSuffix: string | null;
  apnsEnvironment: string | null;
  lastSeenAt: string;
  /** How the push routing reads the relay binding. */
  relayState: string;
  relayBoundAt: string | null;
  liveActivityStartedAt: string | null;
  envelopesReportedAt: string | null;
}

export const DIAGNOSTIC_DEVICE_SELECT = {
  id: true,
  platform: true,
  apnsToken: true,
  apnsEnvironment: true,
  lastSeen: true,
  relayState: true,
  relayConflictAt: true,
  relayBoundAt: true,
  envelopeReportedAt: true,
  relayDeliveries: {
    where: { eventType: LA_START_EVENT },
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { acceptedAt: true },
  },
} as const;

export function diagnosticDevice(d: {
  id: string;
  platform: string;
  apnsToken: string | null;
  apnsEnvironment: string | null;
  lastSeen: Date;
  relayState: string;
  relayConflictAt: Date | null;
  relayBoundAt: Date | null;
  envelopeReportedAt: Date | null;
  /** The device's last Live Activity start, when there is one. */
  relayDeliveries: ReadonlyArray<{ acceptedAt: Date | null }>;
}): DiagnosticDevice {
  const { prefix, suffix } = maskApnsToken(d.apnsToken);
  return {
    id: d.id,
    platform: d.platform,
    hasApnsToken: d.apnsToken !== null && d.apnsToken !== "",
    apnsTokenPrefix: prefix,
    apnsTokenSuffix: suffix,
    apnsEnvironment: d.apnsEnvironment,
    lastSeenAt: d.lastSeen.toISOString(),
    relayState: relayStateAt(d),
    relayBoundAt: d.relayBoundAt?.toISOString() ?? null,
    liveActivityStartedAt:
      d.relayDeliveries[0]?.acceptedAt?.toISOString() ?? null,
    envelopesReportedAt: d.envelopeReportedAt?.toISOString() ?? null,
  };
}

/** What became of one push, in the words of the ledger that saw it. */
export type DeliveryOutcome =
  "pending" | "accepted" | "opened" | "dropped" | "failed" | "sent" | "skipped";

export interface LastDelivery {
  at: string;
  eventType: string;
  outcome: DeliveryOutcome;
  reason: string | null;
}

export type DeliveryKind = "alert" | "silentSync" | "wake" | "liveActivity";

const SYNC_EVENT: SilentKind = "MEDICATION_INTAKE_SYNC";
const WAKE_EVENTS: SilentKind[] = ["DATA_CHANGED", "HEALTHKIT_CATCH_UP"];

/** A relay outbox row's outcome: its status, and whether the device opened it. */
export function relayDeliveryOutcome(row: {
  status: string;
  confirmedAt: Date | null;
}): DeliveryOutcome {
  if (row.status === "accepted") return row.confirmedAt ? "opened" : "accepted";
  if (row.status === "dropped" || row.status === "failed") return row.status;
  return "pending";
}

/** A `push_attempts` result as a delivery outcome. */
export function attemptOutcome(result: string): DeliveryOutcome {
  if (result === "ok") return "accepted";
  if (result === "skipped") return "skipped";
  return "failed";
}

const RELAY_KIND_WHERE: Record<
  DeliveryKind,
  { pushClass: string; eventType?: { in: string[] } }
> = {
  alert: { pushClass: "alert" },
  silentSync: { pushClass: "silent", eventType: { in: [SYNC_EVENT] } },
  wake: { pushClass: "silent", eventType: { in: WAKE_EVENTS } },
  liveActivity: { pushClass: "liveactivity" },
};

const KINDS: DeliveryKind[] = ["alert", "silentSync", "wake", "liveActivity"];

/**
 * The newest relay delivery per kind, and the relay's hold on the device's
 * silent pushes (`owed-silent.ts`). The hold sits on the refused silent push,
 * and no silent push goes to the device while it runs, so the newest silent
 * row of either kind carries it whenever one runs.
 */
async function lastRelayDeliveries(
  deviceId: string,
  now: Date,
): Promise<{
  deliveries: Record<DeliveryKind, LastDelivery | null>;
  silentHold: Date | null;
}> {
  const rows = await Promise.all(
    KINDS.map((kind) =>
      prisma.pushRelayDelivery.findFirst({
        where: { deviceId, ...RELAY_KIND_WHERE[kind] },
        orderBy: { createdAt: "desc" },
        select: {
          eventType: true,
          status: true,
          reason: true,
          confirmedAt: true,
          createdAt: true,
          nextAttemptAt: true,
        },
      }),
    ),
  );
  let silentHold: Date | null = null;
  for (const row of [
    rows[KINDS.indexOf("silentSync")],
    rows[KINDS.indexOf("wake")],
  ]) {
    const at = row?.status === "dropped" ? row.nextAttemptAt : null;
    if (at && at > now && (!silentHold || at > silentHold)) silentHold = at;
  }
  const out = {} as Record<DeliveryKind, LastDelivery | null>;
  KINDS.forEach((kind, i) => {
    const row = rows[i];
    out[kind] = row
      ? {
          at: row.createdAt.toISOString(),
          eventType: row.eventType,
          outcome: relayDeliveryOutcome(row),
          reason: row.reason,
        }
      : null;
  });
  return { deliveries: out, silentHold };
}

async function lastServerDeliveries(device: {
  id: string;
  userId: string;
}): Promise<Record<DeliveryKind, LastDelivery | null>> {
  const silent = (kinds: SilentKind[]) =>
    prisma.pushWake.findFirst({
      where: { deviceId: device.id, kind: { in: kinds } },
      orderBy: { createdAt: "desc" },
      select: { kind: true, createdAt: true },
    });
  const [sync, wake, apnsDevices] = await Promise.all([
    silent([SYNC_EVENT]),
    silent(WAKE_EVENTS),
    prisma.device.count({
      where: { userId: device.userId, apnsToken: { not: null } },
    }),
  ]);
  // The attempt ledger names no device: it speaks for this one only while
  // this is the account's one APNs device.
  const alert =
    apnsDevices === 1
      ? await prisma.pushAttempt.findFirst({
          where: {
            recipientUserId: device.userId,
            channel: "APNS",
            eventType: { not: SYNC_EVENT },
          },
          orderBy: { createdAt: "desc" },
          select: {
            eventType: true,
            result: true,
            reason: true,
            createdAt: true,
          },
        })
      : null;
  const sent = (row: { kind: string; createdAt: Date } | null) =>
    row
      ? {
          at: row.createdAt.toISOString(),
          eventType: row.kind,
          outcome: "sent" as const,
          reason: null,
        }
      : null;
  return {
    alert: alert
      ? {
          at: alert.createdAt.toISOString(),
          eventType: alert.eventType,
          outcome: attemptOutcome(alert.result),
          reason: alert.reason,
        }
      : null,
    silentSync: sent(sync),
    wake: sent(wake),
    liveActivity: null,
  };
}

export interface DevicePushDiagnostics {
  deviceId: string;
  transport: "relay" | "direct" | "none";
  sealed: boolean;
  apnsToken: { prefix: string | null; suffix: string | null } | null;
  apnsEnvironment: string | null;
  relay: {
    state: RelayHealth;
    since: string | null;
    reason: string | null;
  };
  binding: {
    state: string;
    consent: boolean;
    boundAt: string | null;
  };
  budget: {
    windowMinutes: number;
    limit: number | null;
    wakeLimit: number;
    usedInWindow: number;
    wakesUsedInWindow: number;
    owedSyncs: number;
    owedSince: string | null;
    nextFreeAt: string | null;
  };
  /**
   * Who reminds this device of a dose right now, by the decision the send
   * itself reads (`resolveApnsDeliveryTargets`): `server` when the server's
   * reminder goes to it (over `transport`), `client` while the app reminds
   * locally, with `localUntil` the instant the server takes over.
   */
  medicationReminder: {
    delivery: "server" | "client";
    localUntil: string | null;
  };
  /**
   * `push.device.intakeSync` with the reason it reads `degraded`
   * (`intakeSyncOf`); `ok` off the relay, as `push.device` reads.
   */
  intakeSync: IntakeSyncState;
  lastDelivery: Record<DeliveryKind, LastDelivery | null>;
  receipt: {
    reportedAt: string;
    openedAlert: string | null;
    openedSilent: string | null;
  } | null;
  serverTime: string;
}

const DEVICE_DIAGNOSTIC_SELECT = {
  ...ROUTABLE_DEVICE_SELECT,
  userId: true,
  relayBoundAt: true,
  relayConflictAt: true,
  envelopeOpenedAlertId: true,
  envelopeOpenedSilentId: true,
  envelopeReportedAt: true,
  pushDataChange: { select: { intakeSyncOwedAt: true } },
  medicationDelivery: true,
  lastSeen: true,
  localRunwayUntil: true,
  user: { select: { notificationPrefs: true } },
} as const;

/**
 * The push diagnostics of the caller's device named by `deviceToken` (the
 * `X-Device-Id`), or null when it names none of the caller's devices.
 */
export async function devicePushDiagnostics(
  userId: string,
  deviceToken: string | null,
  now: Date = new Date(),
): Promise<DevicePushDiagnostics | null> {
  if (!deviceToken) return null;
  const config = relayConfig();
  const [device, registration] = await Promise.all([
    prisma.device.findFirst({
      where: { userId, token: deviceToken },
      select: DEVICE_DIAGNOSTIC_SELECT,
    }),
    config.available ? loadRegistration(config) : null,
  ]);
  if (!device) return null;
  const route: DeviceRoute = deviceRouteOf(device, {
    registration,
    apnsConfigured: loadApnsConfig() !== null,
  });
  const [window, delivered, intakeSync] = await Promise.all([
    silentWindow(device.id, now),
    route === "relay"
      ? lastRelayDeliveries(device.id, now)
      : lastServerDeliveries(device).then((deliveries) => ({
          deliveries,
          silentHold: null,
        })),
    route === "relay"
      ? intakeSyncOf(device, registration, now)
      : { state: "ok" as const, reason: null },
  ]);
  const lastDelivery = delivered.deliveries;
  const budget = silentBudgetSummary(window, route, delivered.silentHold);
  const owedSince = device.pushDataChange?.intakeSyncOwedAt ?? null;
  const health = relayHealth(registration);
  const localUntil = localDeliveryUntil(
    device,
    CLIENT_MANAGED_APNS_EVENTS.MEDICATION_REMINDER.isClientManaged(
      device.user.notificationPrefs,
    ),
    now,
  );
  return {
    deviceId: device.id,
    transport: transportOf(route),
    sealed: route === "relay" || route === "direct",
    apnsToken: device.apnsToken ? maskApnsToken(device.apnsToken) : null,
    apnsEnvironment: device.apnsEnvironment,
    relay: {
      state: health.state,
      since: health.since?.toISOString() ?? null,
      reason: health.reason,
    },
    binding: {
      state: relayStateAt(device, now),
      consent: device.relayConsentAt !== null,
      boundAt: device.relayBoundAt?.toISOString() ?? null,
    },
    budget: {
      windowMinutes: budget.windowMinutes,
      limit: budget.limit,
      wakeLimit: budget.wakeLimit,
      usedInWindow: budget.usedInWindow,
      wakesUsedInWindow: budget.wakesUsedInWindow,
      // The owed syncs coalesce into one: however many changes arrived, one
      // goes once the budget frees up.
      owedSyncs: owedSince ? 1 : 0,
      owedSince: owedSince?.toISOString() ?? null,
      nextFreeAt: budget.nextFreeAt?.toISOString() ?? null,
    },
    medicationReminder: {
      delivery: localUntil ? "client" : "server",
      localUntil: localUntil?.toISOString() ?? null,
    },
    intakeSync,
    lastDelivery,
    receipt: device.envelopeReportedAt
      ? {
          reportedAt: device.envelopeReportedAt.toISOString(),
          openedAlert: device.envelopeOpenedAlertId,
          openedSilent: device.envelopeOpenedSilentId,
        }
      : null,
    serverTime: now.toISOString(),
  };
}

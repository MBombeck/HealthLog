/**
 * v1.17.1 (#22) — server-authoritative medication-intake cross-device sync.
 *
 * When intake state changes on ONE device — a dose logged, edited,
 * undone, imported or purged — the user's OTHER iOS devices need to
 * reconcile: end or update the running Live Activity, refresh the
 * Home-Screen widget, drop the local reminder. The server is the single
 * source of truth for the intake state, so it owns the fan-out. Per
 * flush it dispatches two APNs pushes per affected device:
 *
 *   1. A SILENT background push (`apns-push-type: background`,
 *      `content-available: 1`, no alert) carrying
 *      `{ eventType: "MEDICATION_INTAKE_SYNC", syncedAt }`. The iOS
 *      `NotificationService` consumes it and runs
 *      `BackgroundSyncCoordinator.runMedicationReconcile`, which
 *      re-reads the full intake state from the API. The payload is a
 *      pure sync trigger — it carries NO health data (no medication
 *      ids, names or dose instants); the reconcile fetches everything
 *      it needs over the authenticated channel.
 *
 *   2. A Live Activity end push (`apns-push-type: liveactivity`, topic
 *      `<bundle>.push-type.liveactivity`) to any device that has a
 *      stored `liveActivityPushToken`, so the lock-screen Activity ends
 *      immediately rather than waiting for the next background wake.
 *
 * COALESCING. Mutations arrive in bursts — a bulk intake marking five
 * doses, or a user resolving several slots back-to-back. The fan-out is
 * throttled per user: the first mutation dispatches immediately (the
 * felt requirement is "the other phone clears within seconds"), and
 * every further mutation inside the coalescing window folds into a
 * single trailing dispatch when the window closes. A burst of N
 * mutations therefore costs at most two fan-outs, and a single bulk
 * request costs exactly one. The window state is in-process
 * (per-Node-process `Map`); with multiple app instances each instance
 * throttles independently, so a burst split across instances can emit
 * one fan-out per instance. That is accepted: the iOS reconcile is
 * idempotent and the deployment model is a single container.
 *
 * APNs-ONLY by design. This event has no Telegram / ntfy / Web Push
 * semantics (those channels have no silent-sync transport), so it never
 * touches the dispatcher cascade — the flush talks straight to the APNs
 * senders via `fanOutIntakeSyncApns`. A future channel with a real
 * silent-sync transport slots in as a sibling fan-out inside
 * `flushIntakeSync`.
 *
 * Origin skip: the device that POSTed the mutation already knows the new
 * state and must not be woken. The caller passes the originating
 * device's registered `token` (the value the iOS client sends as
 * `X-Device-Id`); the matching `Device` row is excluded from the
 * fan-out. A web caller — or a token with no matching row — skips
 * nothing, which is harmless (the iOS reconcile is idempotent). When a
 * trailing flush covers mutations from MORE than one origin device, no
 * device is excluded: each origin still has to learn about the other's
 * change.
 *
 * Best-effort: every failure is swallowed + annotated. A sync-push miss
 * must never fail the intake mutation that triggered it; the canonical
 * row is already persisted.
 */
import { pendingDeletionOf } from "@/lib/account-deletion/pending";
import { prisma } from "@/lib/db";
import { annotate, getEvent } from "@/lib/logging/context";
import {
  loadApnsConfig,
  sendApnsRawPush,
} from "@/lib/notifications/senders/apns";
import { recordPushAttempt } from "@/lib/notifications/senders/push-attempt-record";
import { EVENT_DEFAULT_ENABLED } from "@/lib/notifications/types";

const EVENT_TYPE = "MEDICATION_INTAKE_SYNC";

/**
 * Trailing-coalesce window. Long enough to fold a rapid-fire burst of
 * single-slot mutations into one trailing fan-out, short enough that
 * the second device still reconciles "within seconds".
 */
const COALESCE_WINDOW_MS = 2_000;

export interface IntakeSyncRequest {
  userId: string;
  /**
   * The originating device's registered `Device.token` (sent by the iOS
   * client as the `X-Device-Id` header). The matching device is excluded
   * from the fan-out. `null` / unmatched skips nothing.
   */
  originDeviceToken?: string | null;
}

interface CoalesceWindow {
  /** Mutations that arrived AFTER the leading dispatch. */
  queued: number;
  /** Distinct non-null origin tokens among the queued mutations. */
  originTokens: Set<string>;
  /** Whether any queued mutation had no origin token (web caller). */
  sawNullOrigin: boolean;
}

const openWindows = new Map<string, CoalesceWindow>();

/**
 * Queue a cross-device intake-sync fan-out for the user. Synchronous and
 * non-throwing — the actual dispatch is fire-and-forget, so a push
 * failure can never fail the intake write that triggered it.
 *
 * First call per user opens a coalescing window and dispatches
 * immediately; further calls inside the window fold into one trailing
 * dispatch when it closes.
 */
export function queueMedicationIntakeSync(input: IntakeSyncRequest): void {
  const existing = openWindows.get(input.userId);
  if (existing) {
    existing.queued += 1;
    if (input.originDeviceToken) {
      existing.originTokens.add(input.originDeviceToken);
    } else {
      existing.sawNullOrigin = true;
    }
    return;
  }

  const window: CoalesceWindow = {
    queued: 0,
    originTokens: new Set(),
    sawNullOrigin: false,
  };
  openWindows.set(input.userId, window);

  const timer = setTimeout(() => {
    openWindows.delete(input.userId);
    if (window.queued === 0) return;
    // Exclude an origin only when every queued mutation came from the
    // SAME device; a mixed-origin burst wakes everyone.
    const origin =
      !window.sawNullOrigin && window.originTokens.size === 1
        ? [...window.originTokens][0]
        : null;
    void flushIntakeSync(input.userId, {
      coalesced: window.queued,
      originDeviceToken: origin,
    });
  }, COALESCE_WINDOW_MS);
  // Never keep the process alive for a pending trailing flush.
  timer.unref?.();

  // Leading dispatch — immediate, so the common single-mutation case
  // clears the other device at APNs latency, not after the window.
  void flushIntakeSync(input.userId, {
    coalesced: 0,
    originDeviceToken: input.originDeviceToken ?? null,
  });
}

/**
 * Whether the user has explicitly opted the APNS channel out of
 * MEDICATION_INTAKE_SYNC. There is no second user-facing toggle — this is
 * coherence plumbing — but an explicit per-channel `NotificationPreference`
 * row (APNS / MEDICATION_INTAKE_SYNC / enabled=false) is still honoured so
 * an operator can disable the fan-out. Returns false (suppressed) only on
 * such an explicit opt-out.
 */
async function apnsSyncEnabled(userId: string): Promise<boolean> {
  const channel = await prisma.notificationChannel.findUnique({
    where: { userId_type: { userId, type: "APNS" } },
    select: {
      enabled: true,
      preferences: {
        where: { eventType: EVENT_TYPE },
        select: { enabled: true },
      },
    },
  });
  if (!channel || !channel.enabled) return false;
  const pref = channel.preferences[0];
  if (pref) return pref.enabled;
  return EVENT_DEFAULT_ENABLED.MEDICATION_INTAKE_SYNC;
}

/**
 * One fan-out: silent sync push (+ Live Activity end) to every APNs
 * device except the origin. Records ONE `push_attempts` ledger row per
 * flush and annotates the wide event (best-effort — the trailing flush
 * runs after the triggering request closed, where the annotation is a
 * no-op by construction).
 */
async function flushIntakeSync(
  userId: string,
  opts: { coalesced: number; originDeviceToken: string | null },
): Promise<void> {
  try {
    const config = loadApnsConfig();
    if (!config) {
      // APNs not configured on this deployment — nothing to do. No ledger
      // row: the silent-sync channel is a no-op, not a delivery attempt.
      return;
    }

    // The dispatcher refuses every delivery for an account pending deletion;
    // this push does not go through it, so it asks the same question.
    if (await pendingDeletionOf(userId)) {
      recordPushAttempt({
        userId,
        channel: "APNS",
        eventType: EVENT_TYPE,
        result: "skipped",
        reason: "deletion_pending",
      });
      return;
    }

    if (!(await apnsSyncEnabled(userId))) {
      recordPushAttempt({
        userId,
        channel: "APNS",
        eventType: EVENT_TYPE,
        result: "skipped",
        reason: "intake_sync_disabled",
      });
      return;
    }

    const devices = await prisma.device.findMany({
      where: { userId, apnsToken: { not: null } },
      select: {
        id: true,
        token: true,
        apnsToken: true,
        apnsEnvironment: true,
        liveActivityPushToken: true,
      },
    });

    // Exclude the originating device — it already holds the new state.
    const recipients = devices.filter(
      (d) => !opts.originDeviceToken || d.token !== opts.originDeviceToken,
    );

    annotate({
      meta: {
        medication_intake_sync_devices: recipients.length,
        medication_intake_sync_coalesced: opts.coalesced,
      },
    });

    if (recipients.length === 0) {
      recordPushAttempt({
        userId,
        channel: "APNS",
        eventType: EVENT_TYPE,
        result: "skipped",
        reason: "intake_sync_no_other_devices",
      });
      return;
    }

    await fanOutIntakeSyncApns({
      userId,
      recipients,
      bundleId: config.bundleId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    getEvent()?.addWarning(
      `medication_intake_sync_dispatch_failed: ${message}`,
    );
  }
}

interface SyncRecipient {
  id: string;
  token: string;
  apnsToken: string | null;
  apnsEnvironment: string | null;
  liveActivityPushToken: string | null;
}

/**
 * The APNs leg of the fan-out. Kept as its own unit so a future channel
 * with a silent-sync transport can be added beside it without touching
 * the coalescing or gating layers.
 */
async function fanOutIntakeSyncApns(args: {
  userId: string;
  recipients: SyncRecipient[];
  bundleId: string;
}): Promise<void> {
  // Pure sync trigger — deliberately NO medication id / name / dose
  // instant. The iOS reconcile re-reads the full state itself, and a
  // push payload travels through Apple's infrastructure, so it carries
  // no health data by construction.
  const silentPayload = {
    aps: { "content-available": 1 },
    eventType: EVENT_TYPE,
    syncedAt: new Date().toISOString(),
  };

  let anySuccess = false;
  const deadDeviceIds: string[] = [];
  let lastFailureReason: string | undefined;

  for (const device of args.recipients) {
    if (!device.apnsToken) continue;
    const environment: "sandbox" | "production" =
      device.apnsEnvironment === "production" ? "production" : "sandbox";

    // 1) Silent background reconcile push — one per device.
    const silent = await sendApnsRawPush({
      deviceToken: device.apnsToken,
      environment,
      pushType: "background",
      payload: silentPayload,
      priority: 5,
    });
    if (silent.ok) {
      anySuccess = true;
    } else {
      lastFailureReason = silent.reason;
      if (silent.shouldDisable) deadDeviceIds.push(device.id);
    }

    // 2) Live Activity end push — only when a token is stored.
    if (device.liveActivityPushToken) {
      await sendLiveActivityEnd({
        token: device.liveActivityPushToken,
        environment,
        bundleId: args.bundleId,
      });
    }
  }

  // Reap devices APNs reported as permanently dead on the silent send.
  if (deadDeviceIds.length > 0) {
    await prisma.device
      .deleteMany({ where: { id: { in: deadDeviceIds } } })
      .catch(() => {
        /* best-effort cleanup */
      });
  }

  recordPushAttempt({
    userId: args.userId,
    channel: "APNS",
    eventType: EVENT_TYPE,
    result: anySuccess ? "ok" : "error",
    reason: anySuccess ? null : (lastFailureReason ?? "intake_sync_failed"),
  });
}

/**
 * Push an ActivityKit `end` event to a running Live Activity. The Activity
 * push topic is the app bundle id suffixed with `.push-type.liveactivity`;
 * the body carries the ActivityKit envelope (`event: "end"`, a timestamp,
 * an empty content-state) and nothing else — the push token itself
 * addresses the Activity, so no health data rides along. Best-effort: a
 * failure is annotated, never thrown.
 */
async function sendLiveActivityEnd(args: {
  token: string;
  environment: "sandbox" | "production";
  bundleId: string;
}): Promise<void> {
  try {
    const result = await sendApnsRawPush({
      deviceToken: args.token,
      environment: args.environment,
      pushType: "liveactivity",
      topic: `${args.bundleId}.push-type.liveactivity`,
      priority: 10,
      payload: {
        aps: {
          timestamp: Math.floor(Date.now() / 1000),
          event: "end",
          "content-state": {},
          // Dismiss the ended Activity from the lock screen promptly.
          "dismissal-date": Math.floor(Date.now() / 1000),
        },
      },
    });
    if (!result.ok) {
      getEvent()?.addMeta(
        "medication_intake_sync_liveactivity_failed",
        result.reason ?? "unknown",
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    getEvent()?.addWarning(
      `medication_intake_sync_liveactivity_threw: ${message}`,
    );
  }
}

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
 *      immediately rather than waiting for the next background wake. The
 *      device stores one token and no medication, so the server cannot
 *      tell which dose an Activity shows; it ends Activities only when no
 *      dose the app could be showing is still open
 *      (`liveActivityEndState`), with a full content-state the app can
 *      decode. A token that pushed its end, or that APNs reports dead, is
 *      cleared: it addresses nothing any more.
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
import {
  endedMedicationContentState,
  type MedicationLiveActivityContentState,
} from "@/lib/notifications/live-activity-content-state";
import { TRACKED_INTAKE_EVENT_WHERE } from "@/lib/medications/intake-tracking";
import {
  queueIntakeRecorded,
  type IntakeRecordedEvent,
} from "@/lib/notifications/medication-intake-recorded";

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
  /**
   * The take or skip this mutation recorded, when it recorded one. It also
   * sends the visible confirmation to the owner's other iOS devices
   * (`medication-intake-recorded.ts`), coalesced per slot.
   */
  recorded?: IntakeRecordedEvent | readonly IntakeRecordedEvent[];
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
  const recorded = input.recorded;
  for (const event of Array.isArray(recorded)
    ? recorded
    : recorded
      ? [recorded]
      : []) {
    queueIntakeRecorded({
      userId: input.userId,
      event,
      originDeviceToken: input.originDeviceToken ?? null,
    });
  }
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
        liveActivities: {
          select: {
            id: true,
            pushToken: true,
            medicationId: true,
            slotInstant: true,
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
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
      liveActivityEnd: memoEndState(userId),
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
  liveActivities: Array<{
    id: string;
    pushToken: string;
    medicationId: string;
    slotInstant: Date | null;
  }>;
}

/** The dose a Live Activity shows, as far as the server knows it. */
interface ActivityDose {
  medicationId: string | null;
  slotInstant: Date | null;
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
  /**
   * The final content-state to end an Activity showing this dose with, or
   * null to leave it running.
   */
  liveActivityEnd: (
    dose: ActivityDose,
  ) => Promise<MedicationLiveActivityContentState | null>;
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
  const spentLiveActivityDeviceIds: string[] = [];
  const spentActivityIds: string[] = [];
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

    // 2) Live Activity end pushes. Each registered Activity ends once the
    // dose it shows is answered; the device-level token of a client that
    // registers no list ends only when no dose it could show is open.
    for (const activity of device.liveActivities) {
      const endState = await args.liveActivityEnd(activity);
      if (!endState) continue;
      const spent = await sendLiveActivityEnd({
        token: activity.pushToken,
        environment,
        bundleId: args.bundleId,
        contentState: endState,
      });
      if (spent) spentActivityIds.push(activity.id);
    }
    const endState = device.liveActivityPushToken
      ? await args.liveActivityEnd({ medicationId: null, slotInstant: null })
      : null;
    if (device.liveActivityPushToken && endState) {
      const spent = await sendLiveActivityEnd({
        token: device.liveActivityPushToken,
        environment,
        bundleId: args.bundleId,
        contentState: endState,
      });
      if (spent) spentLiveActivityDeviceIds.push(device.id);
    }
  }

  if (spentActivityIds.length > 0) {
    await prisma.liveActivityToken
      .deleteMany({ where: { id: { in: spentActivityIds } } })
      .catch(() => {
        /* best-effort cleanup */
      });
  }

  // An ended Activity's token, or one APNs reports dead, addresses nothing;
  // the app registers a fresh one with its next Activity.
  if (spentLiveActivityDeviceIds.length > 0) {
    await prisma.device
      .updateMany({
        where: { id: { in: spentLiveActivityDeviceIds } },
        data: { liveActivityPushToken: null },
      })
      .catch(() => {
        /* best-effort cleanup */
      });
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
 * How far around now the iOS app surfaces a dose as a Live Activity
 * (`MedicationLiveActivityPlan`: two hours ahead, three hours overdue).
 */
const LIVE_ACTIVITY_LEAD_MS = 2 * 60 * 60 * 1000;
const LIVE_ACTIVITY_OVERDUE_MS = 3 * 60 * 60 * 1000;

/**
 * The content-state to end the user's medication Live Activities with, or
 * null while any tracked dose the app could be showing is still open (of the
 * Activity's medication, when the device registered it): ending
 * then could close the Activity of a dose that is still due. The silent push
 * beside it lets the app reconcile that case itself.
 */
function memoEndState(userId: string) {
  const memo = new Map<
    string,
    Promise<MedicationLiveActivityContentState | null>
  >();
  return (dose: ActivityDose) => {
    const key = `${dose.medicationId ?? ""}|${dose.slotInstant?.getTime() ?? ""}`;
    let state = memo.get(key);
    if (!state) {
      state = liveActivityEndState(userId, dose);
      memo.set(key, state);
    }
    return state;
  };
}

/**
 * The content-state to end an Activity showing `dose` with, or null while
 * that dose is still open. With a slot: once that slot's live row is taken
 * or skipped. With a medication only: once none of its tracked doses the
 * app could show (two hours ahead to three hours overdue) is open. With
 * neither (a device-level token): once no tracked dose of the account is.
 */
async function liveActivityEndState(
  userId: string,
  dose: ActivityDose,
): Promise<MedicationLiveActivityContentState | null> {
  const now = Date.now();
  if (dose.medicationId !== null && dose.slotInstant !== null) {
    const answered = await prisma.medicationIntakeEvent.count({
      where: {
        userId,
        medicationId: dose.medicationId,
        scheduledFor: dose.slotInstant,
        deletedAt: null,
        OR: [{ takenAt: { not: null } }, { skipped: true }],
      },
    });
    if (answered === 0) return null;
  } else {
    const open = await prisma.medicationIntakeEvent.count({
      where: {
        userId,
        deletedAt: null,
        takenAt: null,
        skipped: false,
        autoMissed: false,
        ...(dose.medicationId !== null && { medicationId: dose.medicationId }),
        scheduledFor: {
          gte: new Date(now - LIVE_ACTIVITY_OVERDUE_MS),
          lte: new Date(now + LIVE_ACTIVITY_LEAD_MS),
        },
        ...TRACKED_INTAKE_EVENT_WHERE,
      },
    });
    if (open > 0) return null;
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timeFormat: true },
  });
  return endedMedicationContentState({
    resolvedAt: new Date(now),
    timeFormat: user?.timeFormat,
  });
}

/**
 * Push an ActivityKit `end` event to a running Live Activity. The Activity
 * push topic is the app bundle id suffixed with `.push-type.liveactivity`;
 * the body carries the ActivityKit envelope (`event: "end"`, a timestamp,
 * the full final content-state the app decodes) and nothing else — the push
 * token itself addresses the Activity, so no health data rides along.
 * Best-effort: a failure is annotated, never thrown. Returns whether the
 * token is spent: the end went out, or APNs reported the token dead.
 */
async function sendLiveActivityEnd(args: {
  token: string;
  environment: "sandbox" | "production";
  bundleId: string;
  contentState: MedicationLiveActivityContentState;
}): Promise<boolean> {
  try {
    const nowS = Math.floor(Date.now() / 1000);
    const result = await sendApnsRawPush({
      deviceToken: args.token,
      environment: args.environment,
      pushType: "liveactivity",
      topic: `${args.bundleId}.push-type.liveactivity`,
      priority: 10,
      payload: {
        aps: {
          timestamp: nowS,
          event: "end",
          "content-state": args.contentState,
          // Dismiss the ended Activity from the lock screen promptly.
          "dismissal-date": nowS,
        },
      },
    });
    if (!result.ok) {
      getEvent()?.addMeta(
        "medication_intake_sync_liveactivity_failed",
        result.reason ?? "unknown",
      );
    }
    return result.ok || result.shouldDisable === true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    getEvent()?.addWarning(
      `medication_intake_sync_liveactivity_threw: ${message}`,
    );
    return false;
  }
}

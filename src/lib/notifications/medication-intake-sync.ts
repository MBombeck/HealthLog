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
import { deleteDeviceRows } from "@/lib/devices/delete-devices";
import type { Prisma } from "@/generated/prisma/client";
import { getEvent } from "@/lib/logging/context";
import { withBackgroundEvent } from "@/lib/logging/background";
import { activeGuardianWhere } from "@/lib/managed-profiles/guardian-where";
import {
  loadApnsConfig,
  sendApnsRawPush,
} from "@/lib/notifications/senders/apns";
import { recordPushAttempt } from "@/lib/notifications/senders/push-attempt-record";
import {
  endedMedicationContentState,
  type MedicationLiveActivityContentState,
} from "@/lib/notifications/live-activity-content-state";
import { openActivityDoses } from "@/lib/push-relay/live-activity";
import {
  queueIntakeRecorded,
  recordedConfirmationEnabled,
  type IntakeRecordedEvent,
} from "@/lib/notifications/medication-intake-recorded";
import { loadPushContext, routeOf } from "@/lib/push-relay/route-device";
import {
  endActivitiesOverRelay,
  intakeSyncEnabled,
  sendSealedIntakeSync,
} from "@/lib/push-relay/medication-pushes";

const EVENT_TYPE = "MEDICATION_INTAKE_SYNC";
/** The wide event every flush writes for itself. */
const FLUSH_EVENT = "notification.intake_sync.flush";

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
  /** When the first of them arrived (the write the trailing flush answers). */
  firstQueuedAt: number | null;
  /** Whether every queued mutation also recorded a take or a skip. */
  allRecorded: boolean;
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
  const recordedHere = Array.isArray(recorded)
    ? recorded.length > 0
    : recorded !== undefined;
  const existing = openWindows.get(input.userId);
  if (existing) {
    existing.queued += 1;
    existing.firstQueuedAt ??= Date.now();
    existing.allRecorded &&= recordedHere;
    if (input.originDeviceToken) {
      existing.originTokens.add(input.originDeviceToken);
    } else {
      existing.sawNullOrigin = true;
    }
    return;
  }

  const window: CoalesceWindow = {
    queued: 0,
    firstQueuedAt: null,
    allRecorded: true,
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
      writtenAt: window.firstQueuedAt ?? Date.now(),
      coalesced: window.queued,
      recordedInFlush: window.allRecorded,
      originDeviceToken: origin,
    });
  }, COALESCE_WINDOW_MS);
  // Never keep the process alive for a pending trailing flush.
  timer.unref?.();

  // Leading dispatch — immediate, so the common single-mutation case
  // clears the other device at APNs latency, not after the window.
  void flushIntakeSync(input.userId, {
    writtenAt: Date.now(),
    coalesced: 0,
    recordedInFlush: recordedHere,
    originDeviceToken: input.originDeviceToken ?? null,
  });
}

/** What the device read of the fan-out selects. */
const SYNC_DEVICE_SELECT = {
  id: true,
  userId: true,
  token: true,
  apnsToken: true,
  apnsEnvironment: true,
  liveActivityPushToken: true,
  pushKeyPublic: true,
  relayState: true,
  relayConsentAt: true,
  relayBindingKey: true,
  liveActivities: {
    select: {
      id: true,
      pushToken: true,
      medicationId: true,
      slotInstant: true,
      activityStatement: true,
      activitySignature: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.DeviceSelect;

/**
 * The accounts whose devices hear of a change to `userId`'s doses: the
 * record itself, and for a managed profile every active Guardian (an
 * accepted, unexpired MANAGE grant), whose phone shows the profile's doses.
 * Each one only while it takes the sync: not pending deletion, its APNs
 * channel on, the sync not switched off. The push carries no data, so a
 * Guardian's device learns nothing it could not read itself.
 */
async function syncCandidates(userId: string): Promise<string[]> {
  const record = await prisma.user.findUnique({
    where: { id: userId },
    select: { managedProfileAt: true },
  });
  if (record?.managedProfileAt == null) return [userId];
  const grants = await prisma.accountGrant.findMany({
    where: {
      grantorId: userId,
      ...activeGuardianWhere(new Date()),
      grantee: { managedProfileAt: null },
    },
    select: { granteeId: true },
  });
  return [
    userId,
    ...new Set(grants.map((g) => g.granteeId).filter((id) => id !== userId)),
  ];
}

/** The candidates that take the sync now, and why the first one does not. */
async function gateAccounts(
  candidates: readonly string[],
): Promise<{ accounts: Set<string>; skipped: string | null }> {
  const accounts = new Set<string>();
  let skipped: string | null = null;
  for (const account of candidates) {
    if (await pendingDeletionOf(account)) {
      skipped ??= "deletion_pending";
      continue;
    }
    if (!(await intakeSyncEnabled(account))) {
      skipped ??= "intake_sync_disabled";
      continue;
    }
    accounts.add(account);
  }
  return { accounts, skipped };
}

/**
 * One fan-out: silent sync push (+ Live Activity end) to every APNs
 * device of the audience except the origin. Records ONE `push_attempts`
 * ledger row per flush and its own wide event
 * (`notification.intake_sync.flush`): it runs after the triggering request
 * has answered, so the request's event is already written by then.
 */
function flushIntakeSync(
  userId: string,
  opts: {
    /** When the change it answers was written (ms epoch). */
    writtenAt: number;
    coalesced: number;
    originDeviceToken: string | null;
    recordedInFlush: boolean;
  },
): Promise<void> {
  return withBackgroundEvent(FLUSH_EVENT, async (evt) => {
    const flushAt = Date.now();
    evt.addMeta("intake_sync_write_to_flush_ms", flushAt - opts.writtenAt);
    evt.addMeta("intake_sync_coalesced", opts.coalesced);
    try {
      const outcome = await flushIntakeSyncInner(userId, opts);
      evt.addMeta("intake_sync_outcome", outcome.result);
      if (outcome.recipients !== undefined) {
        evt.addMeta("intake_sync_devices", outcome.recipients);
        evt.addMeta("intake_sync_routes", outcome.routes ?? {});
        evt.addMeta("intake_sync_deferred", outcome.deferred ?? 0);
        evt.addMeta(
          "intake_sync_guardian_devices",
          outcome.guardianDevices ?? 0,
        );
        evt.addMeta("intake_sync_flush_to_handoff_ms", Date.now() - flushAt);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      evt.addWarning(`medication_intake_sync_dispatch_failed: ${message}`);
    }
  }).catch(() => undefined);
}

interface FlushOutcome {
  result: string;
  recipients?: number;
  routes?: Record<string, number>;
  deferred?: number;
  guardianDevices?: number;
}

async function flushIntakeSyncInner(
  userId: string,
  opts: {
    originDeviceToken: string | null;
    recordedInFlush: boolean;
  },
): Promise<FlushOutcome> {
  const config = loadApnsConfig();
  const candidates = await syncCandidates(userId);
  // Without an APNs key of its own the server reaches only sealed devices
  // (over the relay). With none of those either there is nothing to do; no
  // ledger row: the silent-sync channel is a no-op, not a delivery attempt.
  if (
    !config &&
    (await prisma.device.count({
      where: { userId: { in: candidates }, pushKeyPublic: { not: null } },
    })) === 0
  ) {
    return { result: "no_route" };
  }

  // The dispatcher refuses every delivery for an account pending deletion;
  // this push does not go through it, so it asks the same question, per
  // account, beside the account's own switch for the sync.
  const { accounts, skipped } = await gateAccounts(candidates);
  if (!accounts.has(userId) && skipped) {
    recordPushAttempt({
      userId,
      channel: "APNS",
      eventType: EVENT_TYPE,
      result: "skipped",
      reason: skipped,
    });
  }
  if (accounts.size === 0) return { result: skipped ?? "skipped" };
  const guardians = new Set([...accounts].filter((a) => a !== userId));

  const devices = await prisma.device.findMany({
    where: { userId: { in: [...accounts] }, apnsToken: { not: null } },
    select: SYNC_DEVICE_SELECT,
  });

  // Exclude the originating device — it already holds the new state.
  const recipients = devices.filter(
    (d) => !opts.originDeviceToken || d.token !== opts.originDeviceToken,
  );

  if (recipients.length === 0) {
    recordPushAttempt({
      userId,
      channel: "APNS",
      eventType: EVENT_TYPE,
      result: "skipped",
      reason: "intake_sync_no_other_devices",
    });
    return { result: "no_other_devices", recipients: 0 };
  }

  // A relay device may skip the silent sync only when the confirmation that
  // stands in for it actually goes out. It is opt-in (off by default), so a
  // dose recorded on another surface would otherwise reach the device as
  // neither. The confirmation goes to the record's own devices only, never
  // to a Guardian's.
  const confirmationInFlush =
    opts.recordedInFlush && (await recordedConfirmationEnabled(userId));
  const fanOut = await fanOutIntakeSyncApns({
    userId,
    recipients,
    bundleId: config?.bundleId ?? null,
    liveActivityEnd: memoEndState(userId),
    guardians,
    confirmationFor: new Set(
      confirmationInFlush
        ? recipients.filter((d) => !guardians.has(d.userId)).map((d) => d.id)
        : [],
    ),
  });
  return {
    result: fanOut.anySuccess ? "ok" : "error",
    recipients: recipients.length,
    routes: fanOut.routes,
    deferred: fanOut.deferred,
    guardianDevices: recipients.filter((d) => guardians.has(d.userId)).length,
  };
}

interface SyncRecipient {
  id: string;
  /** The account the device belongs to: the record, or a Guardian. */
  userId: string;
  token: string;
  apnsToken: string | null;
  apnsEnvironment: string | null;
  liveActivityPushToken: string | null;
  pushKeyPublic: string | null;
  relayState: string;
  relayConsentAt: Date | null;
  relayBindingKey: string | null;
  liveActivities: Array<{
    id: string;
    pushToken: string;
    medicationId: string;
    slotInstant: Date | null;
    activityStatement: unknown;
    activitySignature: string | null;
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
  /** This server's own APNs topic, or null when it has no APNs key. */
  bundleId: string | null;
  /** The Guardian accounts among the recipients' owners. */
  guardians: ReadonlySet<string>;
  /**
   * The devices the flush also sends the recorded-dose confirmation to: a
   * relay device among them skips the silent sync (the alert triggers it).
   */
  confirmationFor: ReadonlySet<string>;
  /**
   * The final content-state to end an Activity showing this dose with, or
   * null to leave it running.
   */
  liveActivityEnd: (
    dose: ActivityDose,
  ) => Promise<MedicationLiveActivityContentState | null>;
}): Promise<{
  anySuccess: boolean;
  routes: Record<string, number>;
  deferred: number;
}> {
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

  // Devices with a push key get the sync sealed, over the relay or this
  // server's own key; never the plaintext trigger below.
  const sealedDevices = args.recipients.filter((d) => d.pushKeyPublic);
  const ctx = sealedDevices.length > 0 ? await loadPushContext() : null;
  const routes: Record<string, number> = {};
  let deferred = 0;
  if (ctx) {
    for (const device of sealedDevices) {
      const route = routeOf(device, ctx);
      routes[route] = (routes[route] ?? 0) + 1;
    }
    const sealed = await sendSealedIntakeSync(sealedDevices, ctx, {
      confirmationFor: args.confirmationFor,
    });
    deferred = sealed.deferred.length;
    if (sealed.anyAccepted || sealed.waiting) anySuccess = true;
    else if (sealed.lastFailure) lastFailureReason = sealed.lastFailure;
    else if (deferred > 0) lastFailureReason = "intake_sync_deferred_budget";
  }

  for (const device of args.recipients) {
    if (!device.apnsToken) continue;
    const environment: "sandbox" | "production" =
      device.apnsEnvironment === "production" ? "production" : "sandbox";
    if (!device.pushKeyPublic) routes.legacy = (routes.legacy ?? 0) + 1;
    // A Guardian's device gets the silent sync only: its Activities show
    // its own account's doses, which this change did not touch.
    const guardianDevice = args.guardians.has(device.userId);

    // A relay device's Activities end over the relay, with the statement the
    // device signed at their start.
    if (ctx && routeOf(device, ctx) === "relay") {
      if (guardianDevice) continue;
      const due = [];
      for (const activity of device.liveActivities) {
        if (await args.liveActivityEnd(activity)) due.push(activity);
      }
      spentActivityIds.push(
        ...(await endActivitiesOverRelay(device, due, ctx)),
      );
      continue;
    }
    const bundleId = args.bundleId;
    if (!bundleId) continue;

    // 1) Silent background reconcile push — one per device without a key.
    const silent = device.pushKeyPublic
      ? null
      : await sendApnsRawPush({
          deviceToken: device.apnsToken,
          environment,
          pushType: "background",
          payload: silentPayload,
          priority: 5,
        });
    if (silent?.ok) {
      anySuccess = true;
    } else if (silent) {
      lastFailureReason = silent.reason;
      if (silent.shouldDisable) deadDeviceIds.push(device.id);
    }

    if (guardianDevice) continue;

    // 2) Live Activity end pushes. Each registered Activity ends once the
    // dose it shows is answered; the device-level token of a client that
    // registers no list ends only when no dose it could show is open.
    for (const activity of device.liveActivities) {
      const endState = await args.liveActivityEnd(activity);
      if (!endState) continue;
      const spent = await sendLiveActivityEnd({
        token: activity.pushToken,
        environment,
        bundleId,
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
        bundleId,
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
    await deleteDeviceRows({ id: { in: deadDeviceIds } }).catch(() => {
      /* best-effort cleanup */
    });
  }

  recordPushAttempt({
    userId: args.userId,
    channel: "APNS",
    eventType: EVENT_TYPE,
    result: anySuccess ? "ok" : deferred > 0 ? "skipped" : "error",
    reason: anySuccess
      ? deferred > 0
        ? "intake_sync_deferred_budget"
        : null
      : (lastFailureReason ?? "intake_sync_failed"),
  });
  return { anySuccess, routes, deferred };
}

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
 * app could show is open (`openActivityDoses`: up to two hours ahead, and
 * not yet missed by the medication's own bands). With
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
    // Open by the resolver's bands, the same doses a relay pass would show.
    const open = await openActivityDoses(
      userId,
      new Date(now),
      dose.medicationId ?? undefined,
    );
    if (open.length > 0) return null;
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

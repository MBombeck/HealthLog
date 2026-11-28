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
 *      `<bundle>.push-type.liveactivity`) for every Activity whose dose is
 *      answered, so the lock-screen Activity ends immediately rather than
 *      waiting for the next background wake
 *      (`live-activity-answered.ts`). A token that pushed its end, or that
 *      APNs reports dead, is cleared: it addresses nothing any more. The
 *      five-minute pass sends an end again that the relay did not take.
 *
 * The silent push goes out on every change, whatever else goes to the
 * device. A relay device used to get none when the visible confirmation of
 * the same dose went to it, on the assumption that the alert would start
 * the reconcile in the extension. The two are independent now: an alert
 * that Apple does not deliver in time (it lives 15 minutes over the relay),
 * or that the person's notification settings keep from the extension,
 * leaves the device its sync.
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
 * state and must not be woken. It gets no Live Activity end either: the app
 * is running there and ends its own Activity, and a server push to it would
 * tell the relay and Apple the moment of every dose recorded on the phone
 * itself, which the relay consent text rules out ("on one device, and
 * another of your devices gets the confirmation"). The caller passes the
 * originating
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
import { forgetGoneRegistrations } from "@/lib/notifications/gone-registrations";
import type { Prisma } from "@/generated/prisma/client";
import { withBackgroundEvent } from "@/lib/logging/background";
import { activeGuardianWhere } from "@/lib/managed-profiles/guardian-where";
import {
  loadApnsConfig,
  sendApnsRawPush,
} from "@/lib/notifications/senders/apns";
import { recordPushAttempt } from "@/lib/notifications/senders/push-attempt-record";
import {
  ACTIVITY_DEVICE_SELECT,
  endAnsweredActivities,
  forgetEndedActivities,
  memoEndState,
  type ActivityEndState,
} from "@/lib/notifications/live-activity-answered";
import {
  queueIntakeRecorded,
  type IntakeRecordedEvent,
} from "@/lib/notifications/medication-intake-recorded";
import {
  attemptResultOf,
  loadPushContext,
  owedReason,
  routeOf,
} from "@/lib/push-relay/route-device";
import {
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
    existing.firstQueuedAt ??= Date.now();
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
    originDeviceToken: input.originDeviceToken ?? null,
  });
}

/** What the device read of the fan-out selects. */
const SYNC_DEVICE_SELECT = {
  ...ACTIVITY_DEVICE_SELECT,
  token: true,
} satisfies Prisma.DeviceSelect;

type SyncRecipient = Prisma.DeviceGetPayload<{
  select: typeof SYNC_DEVICE_SELECT;
}>;

/**
 * The accounts whose devices hear of a change to `userId`'s doses: the
 * record itself, and for a managed profile every active Guardian (an
 * accepted, unexpired MANAGE grant), whose phone shows the profile's doses.
 * Each one only while it takes the sync: not pending deletion, its APNs
 * channel on, the sync not switched off. The push carries no data, so a
 * Guardian's device learns nothing it could not read itself. It reaches a
 * Guardian's device over this server's own APNs key only, never over the
 * relay (`fanOutIntakeSyncApns`).
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
  },
): Promise<void> {
  return (async () => {
    // Nothing to reach (no APNs key of its own and no sealed device): no
    // event either, or every write on such a server would log a no-op. A
    // failing probe falls through to the flush, which records it.
    if (!(await mayReachAnyDevice(userId).catch(() => true))) return;
    await withBackgroundEvent(FLUSH_EVENT, async (evt) => {
      const flushAt = Date.now();
      evt.addMeta("intake_sync_write_to_flush_ms", flushAt - opts.writtenAt);
      evt.addMeta("intake_sync_coalesced", opts.coalesced);
      try {
        const outcome = await flushIntakeSyncInner(userId, opts);
        evt.addMeta("intake_sync_outcome", outcome.result);
        if (outcome.reason) evt.addMeta("intake_sync_reason", outcome.reason);
        if (outcome.recipients !== undefined) {
          evt.addMeta("intake_sync_devices", outcome.recipients);
          evt.addMeta("intake_sync_routes", outcome.routes ?? {});
          evt.addMeta("intake_sync_deferred", outcome.deferred ?? 0);
          evt.addMeta(
            "intake_sync_activities_ended",
            outcome.activitiesEnded ?? 0,
          );
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
    });
  })().catch(() => undefined);
}

/** Whether a flush for `userId` could reach any device at all. */
async function mayReachAnyDevice(userId: string): Promise<boolean> {
  if (loadApnsConfig()) return true;
  const candidates = await syncCandidates(userId);
  return (
    (await prisma.device.count({
      where: { userId: { in: candidates }, pushKeyPublic: { not: null } },
    })) > 0
  );
}

/**
 * What a fan-out came to. `ok` only when every device the sync was meant
 * for took it: the relay or Apple accepted it. Every other result names its
 * reason, so the wide event (`intake_sync_reason`) and the ledger row always
 * say why: the type admits no `ok` with a reason and nothing else without
 * one. `deferred`: a device is owed the sync (this server's silent budget,
 * or the relay's, held it back) or its push waits in the outbox for a
 * retry; the ledger records it as `skipped` (`attemptResultOf`).
 */
export type FanOutResult =
  | { result: "ok"; reason: null }
  | { result: "deferred" | "skipped" | "error"; reason: string };

/** A flush that stopped before the fan-out names its reason as well. */
type FlushOutcome = (FanOutResult | { result: string; reason: string }) & {
  recipients?: number;
  routes?: Record<string, number>;
  deferred?: number;
  /** Live Activities this flush ended. */
  activitiesEnded?: number;
  guardianDevices?: number;
};

/**
 * The result of one fan-out from what became of each device's sync:
 * `accepted` (the relay or Apple took it), `deferred` (owed, or waiting in
 * the outbox; `deferredReason` says which first), `failed` (for good; the
 * last failure's code). A failure wins over a deferral, a deferral over a
 * delivery: `ok` needs every device's sync accepted. A device without a
 * route gets no sync to accept (it has to register again) and does not
 * stand in the way of `ok`. A fan-out with nothing
 * sent is `skipped` when every device was left out on purpose (a Guardian's
 * relay device takes none), and `error` when it reached no device for no
 * such reason.
 */
export function fanOutResult(f: {
  accepted: number;
  deferred: number;
  deferredReason: string | undefined;
  failed: number;
  guardianRelaySkipped: number;
  unrouted: number;
  lastFailureReason: string | undefined;
}): FanOutResult {
  if (f.failed > 0) {
    return {
      result: "error",
      reason: f.lastFailureReason ?? "intake_sync_send_failed",
    };
  }
  if (f.deferred > 0) {
    return {
      result: "deferred",
      reason: f.deferredReason ?? "intake_sync_deferred_budget",
    };
  }
  if (f.accepted > 0) return { result: "ok", reason: null };
  if (f.guardianRelaySkipped > 0) {
    return { result: "skipped", reason: "intake_sync_guardian_relay_skipped" };
  }
  if (f.unrouted > 0) {
    return { result: "error", reason: "intake_sync_device_unrouted" };
  }
  return { result: "error", reason: "intake_sync_nothing_sent" };
}

async function flushIntakeSyncInner(
  userId: string,
  opts: { originDeviceToken: string | null },
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
    return { result: "no_route", reason: "intake_sync_no_route" };
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
  if (accounts.size === 0) {
    return skipped
      ? { result: skipped, reason: skipped }
      : { result: "skipped", reason: "intake_sync_no_account" };
  }
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
    return {
      result: "no_other_devices",
      reason: "intake_sync_no_other_devices",
      recipients: 0,
    };
  }

  const fanOut = await fanOutIntakeSyncApns({
    userId,
    recipients,
    bundleId: config?.bundleId ?? null,
    liveActivityEnd: memoEndState(userId),
    guardians,
  });
  return {
    ...fanOut.outcome,
    recipients: recipients.length,
    routes: fanOut.routes,
    deferred: fanOut.deferred,
    activitiesEnded: fanOut.activitiesEnded,
    guardianDevices: recipients.filter((d) => guardians.has(d.userId)).length,
  };
}

/**
 * The APNs leg of the fan-out. Kept as its own unit so a future channel
 * with a silent-sync transport can be added beside it without touching
 * the coalescing or gating layers.
 */
async function fanOutIntakeSyncApns(args: {
  userId: string;
  /** The devices the change is told to: every one but the origin. */
  recipients: SyncRecipient[];
  /** This server's own APNs topic, or null when it has no APNs key. */
  bundleId: string | null;
  /** The Guardian accounts among the recipients' owners. */
  guardians: ReadonlySet<string>;
  /**
   * The final content-state to end an Activity showing this dose with, or
   * null to leave it running.
   */
  liveActivityEnd: ActivityEndState;
}): Promise<{
  outcome: FanOutResult;
  routes: Record<string, number>;
  deferred: number;
  activitiesEnded: number;
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

  // What became of each device's sync (`fanOutResult`).
  let accepted = 0;
  let failed = 0;
  let deferred = 0;
  let deferredReason: string | undefined;
  const deadDeviceIds: string[] = [];
  const spentLiveActivityDeviceIds: string[] = [];
  const spentActivityIds: string[] = [];
  let lastFailureReason: string | undefined;

  // Devices with a push key get the sync sealed, over the relay or this
  // server's own key; never the plaintext trigger below.
  const sealedDevices = args.recipients.filter((d) => d.pushKeyPublic);
  // Read only when a device with a push key is involved: the others take
  // this server's own key or nothing.
  const ctx = sealedDevices.length > 0 ? await loadPushContext() : null;
  const routes: Record<string, number> = {};
  let guardianRelaySkipped = 0;
  if (ctx && sealedDevices.length > 0) {
    // A push about another person's record never goes over the relay, the
    // silent sync included (`relayCarries` holds the same rule for alerts):
    // the timing of a managed profile's doses would reach the relay under the
    // Guardian's device, without the profile's consent. The app refreshes a
    // managed profile when it opens, so the Guardian loses only the update
    // while the app is in the background, and only over the relay.
    const sealedSync = sealedDevices.filter(
      (d) => !(args.guardians.has(d.userId) && routeOf(d, ctx) === "relay"),
    );
    for (const device of sealedDevices) {
      const route = routeOf(device, ctx);
      routes[route] = (routes[route] ?? 0) + 1;
    }
    guardianRelaySkipped = sealedDevices.length - sealedSync.length;
    if (guardianRelaySkipped > 0) {
      routes.guardian_relay_skipped = guardianRelaySkipped;
    }
    const sealed = await sendSealedIntakeSync(sealedSync, ctx);
    // Held back by this server's silent budget: owed before any send.
    if (sealed.deferred.length > 0) {
      deferred += sealed.deferred.length;
      deferredReason ??= "intake_sync_deferred_budget";
    }
    for (const result of Object.values(sealed.devices)) {
      if (result.outcome === "accepted") {
        accepted += 1;
      } else if (result.outcome === "failed") {
        failed += 1;
        lastFailureReason =
          result.via === "relay"
            ? `relay_item_failed:${result.code ?? "failed"}`
            : (result.code ?? "apns_send_failed");
      } else {
        // Owed (the relay refused it for its budget, or dropped it), or
        // waiting in the outbox for a retry: not delivered yet.
        deferred += 1;
        deferredReason ??=
          result.outcome === "owed"
            ? owedReason(result.code)
            : sealed.waitReason;
      }
    }
    // A device that was routable but whose envelope could not be sealed.
    const unsealed = sealedSync.filter(
      (d) =>
        (routeOf(d, ctx) === "relay" || routeOf(d, ctx) === "direct") &&
        !sealed.deferred.includes(d.id) &&
        !(d.id in sealed.devices),
    ).length;
    if (unsealed > 0) {
      failed += unsealed;
      lastFailureReason = sealed.lastFailure ?? "envelope_seal_failed";
    }
  }

  // 1) Silent background reconcile push, in plaintext, to every recipient
  // without a push key. It needs this server's own APNs key.
  for (const device of args.recipients) {
    if (!device.apnsToken || device.pushKeyPublic) continue;
    routes.legacy = (routes.legacy ?? 0) + 1;
    if (!args.bundleId) continue;
    const silent = await sendApnsRawPush({
      deviceToken: device.apnsToken,
      environment:
        device.apnsEnvironment === "production" ? "production" : "sandbox",
      pushType: "background",
      payload: silentPayload,
      priority: 5,
    });
    if (silent.ok) {
      accepted += 1;
    } else {
      failed += 1;
      lastFailureReason = silent.reason;
      if (silent.shouldDisable) deadDeviceIds.push(device.id);
    }
  }

  // 2) Live Activity end pushes. A Guardian's device gets the silent sync
  // only: its Activities show its own account's doses, which this change
  // did not touch.
  for (const device of args.recipients) {
    if (args.guardians.has(device.userId)) continue;
    const ended = await endAnsweredActivities(
      device,
      { ctx, bundleId: args.bundleId },
      args.liveActivityEnd,
    );
    spentActivityIds.push(...ended.activityIds);
    if (ended.deviceToken) spentLiveActivityDeviceIds.push(device.id);
  }
  await forgetEndedActivities(spentActivityIds, spentLiveActivityDeviceIds);

  // Reap devices APNs reported as permanently dead on the silent send.
  await forgetGoneRegistrations("device", deadDeviceIds);

  const activitiesEnded =
    spentActivityIds.length + spentLiveActivityDeviceIds.length;
  const outcome = fanOutResult({
    accepted,
    deferred,
    deferredReason,
    failed,
    guardianRelaySkipped,
    unrouted: routes.none ?? 0,
    lastFailureReason,
  });
  recordPushAttempt({
    userId: args.userId,
    channel: "APNS",
    eventType: EVENT_TYPE,
    result: attemptResultOf(outcome),
    reason: outcome.reason,
  });
  return { outcome, routes, deferred, activitiesEnded };
}

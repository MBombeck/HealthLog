/**
 * Live Activity start and update over the push relay.
 *
 * ActivityKit cannot open an envelope, so the content state of a start or an
 * update travels in the clear: the relay and Apple see when a dose is due.
 * That is why it needs three things beside the relay binding:
 *
 * 1. the operator's switch `PUSH_RELAY_LIVE_ACTIVITY=on` (off by default,
 *    `liveActivityRelayEnabled`);
 * 2. the device's own Live Activity consent, held by the relay
 *    (`Device.liveActivityConsentAt`, `live-activity-registration.ts`);
 * 3. a statement by the device's binding key: `hl-la-start-v1` over the
 *    push-to-start token for a start, `hl-activity-v1` over the Activity's
 *    update token for an update.
 *
 * The content state is the relay's closed template and nothing else
 * ({@link relayContentState}): six keys, fixed types, closed enumerations, a
 * bounded `countdownTarget` in unix seconds, no medication name and no free
 * text. A start names the attributes the relay sets itself
 * (`HealthLogDoseAttributes`, `{ "v": 1, "s": "<start id>" }`); the dose
 * never travels.
 *
 * The pass (`push-live-activity`, every five minutes) starts at most one
 * Activity per eligible device and pass, once per dose, unless the device
 * already runs one for it. Once per dose is the server's own record: each
 * start's outbox row keeps its dose (`doseStartHeld`), before the device
 * reports the Activity and across restarts; the row's ref is the start id
 * the relay writes into the Activity's attributes (`"s"`), which the app
 * echoes when it registers the Activity, so each Activity is named by its
 * own start. How many run at once depends on the app: one that echoes the
 * start id gets one Activity per dose, up to {@link MAX_DEVICE_ACTIVITIES};
 * one that does not keeps to one relay-started Activity on the device
 * ({@link runDeviceLiveActivities}). The dose is the earliest of those
 * entering their window ({@link startCandidates}): its medication has the
 * person's Live Activity
 * opt-in (`liveActivityEnabled`), it lies no more than the lead ahead, and
 * the resolver calls it pending or due. A dose already overdue, missed,
 * taken or skipped never gets a start, so the first pass after the consent
 * starts nothing that is already behind. A server-started Activity whose
 * medication may no longer have one (opt-in off, paused, ended) ends. A
 * start or update counts only once the relay accepted it; one that failed
 * for good is tried again after a cool-down (`live-activity-settle.ts`); and it updates every running Activity
 * whose state changed since the last update, of those it started itself
 * (`relayStarted`). The state is the server's one resolved dose
 * (`medications/dose-state/resolve.ts`): the medication's own bands
 * (`dueAt`, `overdueSince`, `missedAfter`), the same the today rows, the web
 * and the reminders read; nothing here knows a due or overdue minute. A dose
 * the resolver calls missed has nothing left to show, and the pass ends its
 * Activity, whoever started it. Taken and skipped doses end the Activity as
 * before (`medication-intake-sync.ts`).
 *
 * When a dose starts is the app's decision: `MedicationLiveActivityPlan`
 * surfaces a dose from `leadWindow` (two hours) before its scheduled time,
 * and the server starts no earlier ({@link ACTIVITY_LEAD_MS}). How long it
 * stays is the resolver's: until `missedAfter`.
 *
 * None of this depends on the way the device's ordinary pushes take. A server
 * with its own APNs key and a relay registration sends alerts and syncs over
 * its key and starts and updates Activities over the relay
 * (`laRelayBlock`); there is no start over its own key, so a dose never
 * gets two.
 */
import { randomBytes } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { pendingDeletionOf } from "@/lib/account-deletion/pending";
import { getEvent } from "@/lib/logging/context";
import { TRACKED_INTAKE_EVENT_WHERE } from "@/lib/medications/intake-tracking";
import { projectUpcomingIntakes } from "@/lib/medications/scheduling/project-today-intakes";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import {
  activityShowsDose,
  STARTABLE_MEDICATION_WHERE,
} from "@/lib/push-relay/activity-slot";
import {
  LA_PASS_DEVICE_WHERE,
  laVerdict,
  liveActivityStartState,
} from "@/lib/push-relay/live-activity-eligibility";
import {
  laStartTokenUsable,
  statementIat,
} from "@/lib/push-relay/live-activity-start-token";
import {
  endAndForget,
  LA_ACTIVITY_SELECT,
  relayStartedOf,
} from "@/lib/push-relay/live-activity-relay-end";
import { newUlid } from "@/lib/push-relay/plaintext";
import { passPageOffset } from "@/lib/push-relay/pass-window";
import {
  loadPushContext,
  ROUTABLE_DEVICE_SELECT,
  type PushContext,
} from "@/lib/push-relay/route-device";
import {
  sendRelayItems,
  type RelayItemInput,
} from "@/lib/push-relay/relay-send";
import {
  COUNTDOWN_PAST_S,
  doseContentState,
  sameState,
  type ActivityDose,
  type RelayContentState,
} from "@/lib/push-relay/live-activity-content";
import {
  doseAt,
  DOSE_ROW_SELECT,
  resolveRows,
  slotStillScheduled,
} from "@/lib/push-relay/live-activity-dose";
import {
  relayActivityKind,
  relayEventAllowed,
  supersededRelayActivities,
} from "@/lib/push-relay/live-activity-owner";
import {
  LA_START_EVENT,
  LA_UPDATE_EVENT,
  refusedRecently,
  doseStartHeld,
  releaseDoseStarts,
  updatesInFlight,
} from "@/lib/push-relay/live-activity-settle";
import {
  RELAY_ACTIVITY_RUNNING_MAX_MS,
  unreportedStartCount,
} from "@/lib/push-relay/live-activity-started";

/**
 * How long before its scheduled time a dose gets an Activity. The app owns
 * this: `MedicationLiveActivityPlan.leadWindow` in the iOS client, which
 * plans its own Activities from the same two hours. It is no dose state; the
 * state comes from the resolver.
 */
export const ACTIVITY_LEAD_MS = 2 * 3600_000;
/** The relay's window for an Activity statement, less five minutes of margin. */
const ACTIVITY_STATEMENT_MAX_AGE_S = 12 * 3600 - 300;
/** A start or update is worth nothing late. */
const PUSH_LIFETIME_S = 15 * 60;
/**
 * The most Live Activities the pass lets a device run, its own and the app's
 * together: those registered, and the relay starts not reported yet. The
 * system refuses an app's Activities past a limit of its own, which Apple
 * does not document; this stays below it and leaves the app room for one of
 * its own. Doses due together past this wait until one is answered.
 */
export const MAX_DEVICE_ACTIVITIES = 4;

const DEVICE_SELECT = {
  ...ROUTABLE_DEVICE_SELECT,
  userId: true,
  relayBindingKey: true,
  liveActivityConsentAt: true,
  laStartToken: true,
  laStartStatement: true,
  laStartSignature: true,
  laStartIdsAt: true,
  liveActivities: { select: LA_ACTIVITY_SELECT },
} as const;

type LaDevice = Prisma.DeviceGetPayload<{ select: typeof DEVICE_SELECT }>;

/**
 * The open tracked doses an Activity may show at `now`, soonest first, once
 * their rows are in place ({@link projectUpcomingIntakes}): the
 * resolver calls them pending, due or overdue (never missed), and their slot
 * lies no more than {@link ACTIVITY_LEAD_MS} ahead. Of the past, only what
 * the relay could still count from is read (`COUNTDOWN_PAST_S`); how long a
 * dose stays open is the resolver's answer, not this bound's.
 */
export async function openActivityDoses(
  userId: string,
  now: Date,
  medicationId?: string,
): Promise<ActivityDose[]> {
  // The rows come from the server's own projection, not from a read of the
  // today list: a person who does not open the app that day still gets the
  // Activity of a dose ahead, and one just past midnight from the evening.
  await projectUpcomingIntakes({
    userId,
    userTz: await resolveUserTimezone(userId),
    now,
    aheadMs: ACTIVITY_LEAD_MS,
  });
  const rows = await prisma.medicationIntakeEvent.findMany({
    where: {
      userId,
      deletedAt: null,
      takenAt: null,
      skipped: false,
      autoMissed: false,
      ...(medicationId !== undefined && { medicationId }),
      scheduledFor: {
        gte: new Date(now.getTime() - COUNTDOWN_PAST_S * 1000),
        lte: new Date(now.getTime() + ACTIVITY_LEAD_MS),
      },
      // A left-over open row of a paused or ended medication is no dose due.
      medication: {
        ...TRACKED_INTAKE_EVENT_WHERE.medication,
        active: true,
        pausedAt: null,
        endedAt: null,
      },
    },
    orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
    select: DOSE_ROW_SELECT,
  });
  const doses = await resolveRows(userId, rows, now);
  return doses.filter((d) =>
    ["pending", "due", "overdue"].includes(d.resolved.state),
  );
}

/**
 * Whether the pass may start an Activity for `dose` at `now`: the dose is
 * entering its window. Its medication has the Live Activity opt-in; its slot
 * lies no more than {@link ACTIVITY_LEAD_MS} ahead; and the resolver, the
 * one the today list reads, calls it pending or due. Overdue and missed are
 * behind: the app plans no Activity for them and neither does the server.
 * Taken, skipped and extra doses are no open slot at all.
 */
export function startableDose(
  dose: Pick<ActivityDose, "scheduledFor" | "resolved" | "liveActivityEnabled">,
  now: Date,
): boolean {
  if (!dose.liveActivityEnabled) return false;
  if (dose.resolved.state !== "pending" && dose.resolved.state !== "due") {
    return false;
  }
  return dose.scheduledFor.getTime() - ACTIVITY_LEAD_MS <= now.getTime();
}

/**
 * The doses the pass may start an Activity for, in the order it tries them:
 * the startable doses ({@link startableDose}), earliest slot first; on a tie
 * the lowest medication id, so the order never depends on the order the
 * rows were read in.
 */
export function startCandidates<
  T extends Pick<
    ActivityDose,
    "medicationId" | "scheduledFor" | "resolved" | "liveActivityEnabled"
  >,
>(doses: readonly T[], now: Date): T[] {
  return doses
    .filter((dose) => startableDose(dose, now))
    .sort(
      (a, b) =>
        a.scheduledFor.getTime() - b.scheduledFor.getTime() ||
        (a.medicationId < b.medicationId
          ? -1
          : a.medicationId > b.medicationId
            ? 1
            : 0),
    );
}

/**
 * A Live Activity start's ref, which the relay writes into the Activity's
 * attributes (`"s"`) where it and Apple read it in the clear: 16 random
 * bytes, base64url, and nothing else in it. A ULID would carry the instant
 * of the start.
 */
export function newLaStartRef(): string {
  return `las-${randomBytes(16).toString("base64url")}`;
}

export interface LaPassFacts {
  devices: number;
  started: number;
  updated: number;
  /** Devices whose run threw; the pass carried on past each. */
  failed: number;
}

/**
 * The start item for `device`'s next dose to start, or null when none is.
 *
 * `exact`: the app names each relay-started Activity by its start id, so
 * the first candidate that is neither started nor shown yet goes. Without
 * it only the earliest candidate may go (the 1.49 rule): a later dose never
 * starts beside the one running, so the server can name the one Activity an
 * app without start ids registers.
 */
async function startItem(
  device: LaDevice,
  timeFormat: string | null,
  now: Date,
  exact: boolean,
): Promise<{ item: RelayItemInput; dose: ActivityDose } | null> {
  if (!laStartTokenUsable(device, now)) return null;
  if (await refusedRecently(device.id, LA_START_EVENT, now)) return null;
  const candidates = startCandidates(
    await openActivityDoses(device.userId, now),
    now,
  );
  for (const dose of exact ? candidates : candidates.slice(0, 1)) {
    const item = await doseStartItem(device, dose, timeFormat, now);
    if (item) return { dose, item };
  }
  return null;
}

/** The start item for `dose`, or null when the dose is started or shown. */
async function doseStartItem(
  device: LaDevice,
  dose: ActivityDose,
  timeFormat: string | null,
  now: Date,
): Promise<RelayItemInput | null> {
  const nowS = Math.floor(now.getTime() / 1000);
  const state = doseContentState(dose, timeFormat, now);
  if (!state) return null;
  // Once per dose: a start the relay accepted, or one still in flight, read
  // from the start rows themselves, before the device reports the Activity
  // and whatever it runs. A start that failed for good no longer holds the
  // dose (`live-activity-settle.ts`).
  if (await doseStartHeld(device.id, dose.medicationId, dose.scheduledFor)) {
    return null;
  }
  // One owner per dose: an Activity the device already runs for it, the
  // app's own (`MedicationActivityAttributes`, with its Take button) above
  // all, keeps the relay from starting a second one beside it. The reverse
  // order, a relay start the app's own Activity follows, ends the relay one
  // ({@link supersededRelayActivities}).
  if (
    device.liveActivities.some((a) =>
      activityShowsDose(a, dose.medicationId, dose.scheduledFor),
    )
  ) {
    return null;
  }
  return {
    deviceId: device.id,
    ref: newLaStartRef(),
    pushClass: "liveactivity",
    eventType: LA_START_EVENT,
    activity: {
      event: "start",
      state,
      token: device.laStartToken as string,
      bindingKey: device.relayBindingKey as string,
      statement: device.laStartStatement as Record<string, unknown>,
      signature: device.laStartSignature as string,
    },
    expiresAt: new Date((nowS + PUSH_LIFETIME_S) * 1000),
    dose: { medicationId: dose.medicationId, slotInstant: dose.scheduledFor },
  };
}

type LaActivity = LaDevice["liveActivities"][number];

/**
 * The relay update item that shows `state` on `activity`, or null when the
 * relay may not update it ({@link relayEventAllowed}).
 */
export function relayUpdateItem(
  device: Pick<LaDevice, "id" | "relayBindingKey">,
  activity: Pick<
    LaActivity,
    "pushToken" | "relayStarted" | "activityStatement" | "activitySignature"
  >,
  state: RelayContentState,
  now: Date,
): RelayItemInput | null {
  if (!relayEventAllowed(relayActivityKind(activity), "update")) return null;
  if (!activity.activitySignature || !device.relayBindingKey) return null;
  const nowS = Math.floor(now.getTime() / 1000);
  return {
    deviceId: device.id,
    ref: `lau-${newUlid(now.getTime())}`,
    pushClass: "liveactivity",
    eventType: LA_UPDATE_EVENT,
    activity: {
      event: "update",
      state,
      token: activity.pushToken.toLowerCase(),
      bindingKey: device.relayBindingKey,
      statement: activity.activityStatement as Record<string, unknown>,
      signature: activity.activitySignature,
    },
    expiresAt: new Date((nowS + PUSH_LIFETIME_S) * 1000),
  };
}

/**
 * The update items for `device`'s running Activities whose state changed,
 * and the Activities that end: those whose dose the resolver calls missed,
 * and those the server started for a medication that may no longer have one
 * (its Live Activity opt-in turned off, paused, ended, deleted; or started
 * before the start honoured the opt-in).
 *
 * Only an Activity the server started over the relay (`relayStarted`) is
 * updated here. One the app started itself has the app's own attributes
 * type, whose content state is not the relay template: an update would
 * decode wrong or not at all. It keeps the direct path, and still ends
 * here when its dose is missed, and on the intake path when it is answered.
 */
async function updateItems(
  device: LaDevice,
  timeFormat: string | null,
  now: Date,
): Promise<{
  updates: Array<{
    item: RelayItemInput;
    rowId: string;
    state: RelayContentState;
  }>;
  ending: LaActivity[];
}> {
  const nowS = Math.floor(now.getTime() / 1000);
  const updates = [];
  const ending: LaActivity[] = [];
  const relayOwned = (a: LaActivity) =>
    relayActivityKind(a) === "relay_started";
  const relayStarted = device.liveActivities.some(relayOwned);
  const startable = relayStarted
    ? new Set(
        (
          await prisma.medication.findMany({
            where: {
              userId: device.userId,
              id: {
                in: device.liveActivities
                  .filter(relayOwned)
                  .flatMap((a) => (a.medicationId ? [a.medicationId] : [])),
              },
              ...STARTABLE_MEDICATION_WHERE,
            },
            select: { id: true },
          })
        ).map((m) => m.id),
      )
    : new Set<string>();
  // An update is final only once accepted: one still in flight is not sent
  // twice, and after a refusal the device's updates wait out the cool-down.
  const superseded = new Set(
    supersededRelayActivities(device.liveActivities).map((a) => a.id),
  );
  const [inFlight, refused] = relayStarted
    ? await Promise.all([
        updatesInFlight(device.id),
        refusedRecently(device.id, LA_UPDATE_EVENT, now),
      ])
    : [new Set<string>(), false];
  for (const activity of device.liveActivities) {
    const iat = statementIat(activity.activityStatement);
    if (
      !activity.activitySignature ||
      iat === null ||
      nowS - iat > ACTIVITY_STATEMENT_MAX_AGE_S
    ) {
      continue;
    }
    const { medicationId, slotInstant } = activity;
    // Registered without a dose the server could name (`POST /api/devices`
    // attributes one only to the single running relay start): it ends.
    if (medicationId === null) {
      ending.push(activity);
      continue;
    }
    if (!slotInstant) continue;
    if (
      superseded.has(activity.id) ||
      (relayOwned(activity) && !startable.has(medicationId))
    ) {
      ending.push(activity);
      continue;
    }
    const dose = await doseAt(device.userId, medicationId, slotInstant, now);
    // A server-started Activity whose slot the schedule no longer has (its
    // time edited away, the open row tombstoned with it) shows a dose that
    // is not due: it ends. A slot whose row is only not minted yet keeps it.
    if (
      !dose &&
      relayOwned(activity) &&
      !(await slotStillScheduled(device.userId, medicationId, slotInstant, now))
    ) {
      ending.push(activity);
      continue;
    }
    // Taken and skipped end the Activity on their own paths: the intake
    // flush at once, and this job's retry of an end the relay did not take
    // (`notifications/live-activity-answered.ts`).
    if (
      !dose ||
      dose.resolved.state === "taken" ||
      dose.resolved.state === "taken_late" ||
      dose.resolved.state === "skipped"
    ) {
      continue;
    }
    const state = doseContentState(dose, timeFormat, now);
    if (!state) {
      ending.push(activity);
      continue;
    }
    if (refused) continue;
    if (inFlight.has(activity.pushToken.toLowerCase())) continue;
    if (sameState(state, activity.lastRelayState)) continue;
    const item = relayUpdateItem(device, activity, state, now);
    if (item) updates.push({ rowId: activity.id, state, item });
  }
  return { updates, ending };
}

/**
 * For an app without start ids: whether the device's last relay start may
 * still be running unseen, so that no other relay start may join it (its
 * token is unknown: it cannot be ended). That holds only while all of these
 * do:
 *
 * - the start is in flight, or the relay accepted it, less than
 *   {@link RELAY_ACTIVITY_RUNNING_MAX_MS} ago (the system has ended it after
 *   that);
 * - the app has not registered it (a registered one is ended before the
 *   next start, or the next start waits for that end; one the app has
 *   registered and dropped again is gone);
 * - it still holds its dose, its medication still keeps a relay Activity,
 *   and its dose is still in its window: pending or due.
 *
 * The last bound is the grace an unregistered start gets. The app registers
 * a running Activity whenever it runs; once the dose's own window is over
 * without that, holding the next dose back would trade a reminder the
 * person needs for an ambiguity the device route already resolves safely
 * (two Activities posted without their dose keep none, and the pass ends
 * both). A start that holds nothing never holds forever.
 */
async function unreportedRelayStart(
  device: LaDevice,
  now: Date,
): Promise<boolean> {
  const last = await prisma.pushRelayDelivery.findFirst({
    where: { deviceId: device.id, eventType: LA_START_EVENT },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      status: true,
      laReportedAt: true,
      medicationId: true,
      slotInstant: true,
      createdAt: true,
    },
  });
  if (!last) return false;
  const { medicationId, slotInstant: slot } = last;
  if (
    (last.status !== "pending" && last.status !== "accepted") ||
    last.laReportedAt !== null ||
    !medicationId ||
    !slot ||
    now.getTime() - last.createdAt.getTime() > RELAY_ACTIVITY_RUNNING_MAX_MS
  ) {
    return false;
  }
  if (
    device.liveActivities.some((a) => activityShowsDose(a, medicationId, slot))
  ) {
    return false;
  }
  const startable = await prisma.medication.count({
    where: {
      id: medicationId,
      userId: device.userId,
      ...STARTABLE_MEDICATION_WHERE,
    },
  });
  if (startable === 0) return false;
  const dose = await doseAt(device.userId, medicationId, slot, now);
  return (
    dose !== null &&
    (dose.resolved.state === "pending" || dose.resolved.state === "due")
  );
}

/**
 * Whether the relay can still end `activity`: it carries the Activity's
 * signed statement, within the window the relay accepts. One past that
 * window was registered more than twelve hours ago, so the system has ended
 * it ({@link RELAY_ACTIVITY_RUNNING_MAX_MS}); it holds no start back.
 */
function relayEndable(activity: LaActivity, now: Date): boolean {
  const iat = statementIat(activity.activityStatement);
  return (
    activity.activitySignature !== null &&
    iat !== null &&
    Math.floor(now.getTime() / 1000) - iat <= ACTIVITY_STATEMENT_MAX_AGE_S
  );
}

/** Start and update the Live Activities of one device. */
export async function runDeviceLiveActivities(
  device: LaDevice,
  ctx: PushContext,
  now: Date,
): Promise<{ started: number; updated: number }> {
  const verdict = laVerdict(device, ctx, now);
  if (!verdict.end) return { started: 0, updated: 0 };
  if (await pendingDeletionOf(device.userId)) return { started: 0, updated: 0 };
  const user = await prisma.user.findUnique({
    where: { id: device.userId },
    select: { timeFormat: true },
  });
  const timeFormat = user?.timeFormat ?? null;
  // The switch off or the consent gone: no start and no update, and what
  // runs ends: every relay-started Activity, which nothing updates any more,
  // and what the pass ends anyway (a missed dose, whoever started it).
  if (!verdict.update) {
    const { ending } = await updateItems(device, timeFormat, now);
    await endAndForget(
      device,
      [...new Set([...relayStartedOf(device.liveActivities), ...ending])],
      ctx,
    );
    return { started: 0, updated: 0 };
  }
  // An app that echoes the start id names each relay-started Activity by
  // its start (`POST /api/devices`), so the device may run one per dose, up
  // to MAX_DEVICE_ACTIVITIES with its own, and a new start ends nothing.
  //
  // An app without it (iOS builds up to 1.7) registers a relay-started
  // Activity without its dose and leaves the server to name it, which it can
  // only while one runs. So that device keeps one relay-started Activity: a
  // start for an earlier dose first ends the relay-started Activities still
  // running, and goes out only once the relay took every one of those ends,
  // in the same pass; otherwise it waits for a later pass. A start whose
  // Activity the app has not registered yet cannot be ended: the new one
  // waits until it is registered, dropped, or its dose's window is over
  // ({@link unreportedRelayStart}). An Activity ended that way gives its
  // dose back, so it starts again once the earlier dose is done.
  const exact = device.laStartIdsAt !== null;
  const room = exact
    ? device.liveActivities.length +
        (await unreportedStartCount(device.id, now)) <
      MAX_DEVICE_ACTIVITIES
    : !(await unreportedRelayStart(device, now));
  let start = room ? await startItem(device, timeFormat, now, exact) : null;
  const { updates: proposed, ending } = await updateItems(
    device,
    timeFormat,
    now,
  );
  const making =
    start && !exact
      ? device.liveActivities.filter(
          (a) =>
            relayActivityKind(a) === "relay_started" &&
            !ending.includes(a) &&
            relayEndable(a, now),
        )
      : [];
  // A missed dose has nothing left to show, and a medication without the
  // opt-in gets no server-started Activity: end it, and forget the token
  // once the relay took the end or reported the Activity gone.
  const spent = await endAndForget(device, [...ending, ...making], ctx);
  // An Activity ended to make room for another dose's start was not ended
  // because its dose was done: give the dose back, so it starts again once
  // the other one is over. Its start row would hold it for good otherwise.
  for (const made of making) {
    if (!spent.has(made.id) || !made.medicationId || !made.slotInstant) {
      continue;
    }
    await releaseDoseStarts(
      { deviceId: device.id },
      { medicationId: made.medicationId, slotInstant: made.slotInstant },
    );
  }
  if (making.some((a) => !spent.has(a.id))) start = null;
  const updates = proposed.filter((u) => !spent.has(u.rowId));
  const items = [...(start ? [start.item] : []), ...updates.map((u) => u.item)];
  if (items.length === 0) return { started: 0, updated: 0 };
  const summary = await sendRelayItems(items, ctx.config);
  const accepted = new Set(
    summary.answers
      .filter((a) => a.status === 200 && a.code === "accepted")
      .map((a) => a.ref),
  );
  const started = start && accepted.has(start.item.ref) ? 1 : 0;
  let updated = 0;
  for (const u of updates) {
    if (summary.activityGone.includes(u.item.ref)) {
      await prisma.liveActivityToken.deleteMany({ where: { id: u.rowId } });
    } else if (accepted.has(u.item.ref)) {
      updated += 1;
    }
  }
  return { started, updated };
}

/** Devices per pass, and the pass period (`push-live-activity`, 5 min). */
export const PASS_LIMIT = 500;
const PASS_PERIOD_MS = 5 * 60_000;

/**
 * The pass over every device the relay may start, update or end an Activity
 * on ({@link LA_PASS_DEVICE_WHERE}).
 */
export async function runLiveActivityRelayPass(
  now: Date = new Date(),
): Promise<LaPassFacts> {
  const facts: LaPassFacts = { devices: 0, started: 0, updated: 0, failed: 0 };
  const ctx = await loadPushContext();
  if (!ctx.registration?.instanceId) return facts;
  const where = LA_PASS_DEVICE_WHERE;
  // Capped per tick; the page rotates with the tick, so a device past the
  // first page is reached within a bounded number of passes.
  const devices = await prisma.device.findMany({
    where,
    select: DEVICE_SELECT,
    orderBy: { id: "asc" },
    skip: passPageOffset({
      total: await prisma.device.count({ where }),
      pageSize: PASS_LIMIT,
      now,
      periodMs: PASS_PERIOD_MS,
    }),
    take: PASS_LIMIT,
  });
  // Why a device gets no start, by the first reason in the way, so a server
  // whose Activities never start says why in its log.
  const blocked: Record<string, number> = {};
  for (const device of devices) {
    facts.devices += 1;
    const state = liveActivityStartState(device, ctx, now);
    if (state !== "ready") blocked[state] = (blocked[state] ?? 0) + 1;
    try {
      const done = await runDeviceLiveActivities(device, ctx, now);
      facts.started += done.started;
      facts.updated += done.updated;
    } catch (err) {
      facts.failed += 1;
      getEvent()?.addWarning(
        `live_activity_relay_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (Object.keys(blocked).length > 0) {
    getEvent()?.addMeta("live_activity_start_blocked", blocked);
  }
  return facts;
}

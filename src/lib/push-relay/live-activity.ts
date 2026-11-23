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
 * text. A start names the fixed attributes the relay sets itself
 * (`HealthLogDoseAttributes`, `{ "v": 1 }`); the dose never travels.
 *
 * The pass (`push-live-activity`, every five minutes) starts an Activity for
 * one dose of each eligible device, once per dose, unless the device already
 * runs one for it. The dose is the earliest of those entering their window
 * ({@link pickStartDose}): its medication has the person's Live Activity
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
 * A server with its own APNs key does none of this: its direct path is
 * unchanged.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { pendingDeletionOf } from "@/lib/account-deletion/pending";
import { getEvent } from "@/lib/logging/context";
import { TRACKED_INTAKE_EVENT_WHERE } from "@/lib/medications/intake-tracking";
import { resolveDosesByRow } from "@/lib/medications/dose-state/today";
import type { ResolvedDose } from "@/lib/medications/dose-state/resolve";
import { slotsHeldBySnooze } from "@/lib/medications/snooze-scope";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import {
  activitySlotWindow,
  sameActivitySlot,
  STARTABLE_MEDICATION_WHERE,
} from "@/lib/push-relay/activity-slot";
import { liveActivityRelayEnabled } from "@/lib/push-relay/config";
import { endActivitiesOverRelay } from "@/lib/push-relay/medication-pushes";
import { fromBase64Url } from "@/lib/push-relay/encoding";
import { newUlid } from "@/lib/push-relay/plaintext";
import { passPageOffset } from "@/lib/push-relay/pass-window";
import {
  loadPushContext,
  ROUTABLE_DEVICE_SELECT,
  routeOf,
  type PushContext,
} from "@/lib/push-relay/route-device";
import {
  sendRelayItems,
  type RelayItemInput,
} from "@/lib/push-relay/relay-send";
import {
  LA_START_EVENT,
  LA_UPDATE_EVENT,
  refusedRecently,
  startHeld,
  updatesInFlight,
} from "@/lib/push-relay/live-activity-settle";

export const RELAY_LA_STATUSES = [
  "pending",
  "due",
  "overdue",
  "snoozed",
  "taken",
  "skipped",
] as const;
export type RelayLaStatus = (typeof RELAY_LA_STATUSES)[number];
const TIME_FORMATS = ["AUTO", "H12", "H24"] as const;

/** The relay's closed content-state template. */
export type RelayContentState = {
  status: RelayLaStatus;
  countdownTarget: number;
  isOverdue: boolean;
  confirmed: boolean;
  pendingConfirm: boolean;
  timeFormatRaw: (typeof TIME_FORMATS)[number];
};

const KEYS = [
  "status",
  "countdownTarget",
  "isOverdue",
  "confirmed",
  "pendingConfirm",
  "timeFormatRaw",
] as const;

/** `countdownTarget` bounds around the relay clock (`0` = no countdown). */
const COUNTDOWN_PAST_S = 24 * 3600;
const COUNTDOWN_FUTURE_S = 48 * 3600;
/**
 * How long before its scheduled time a dose gets an Activity. The app owns
 * this: `MedicationLiveActivityPlan.leadWindow` in the iOS client, which
 * plans its own Activities from the same two hours. It is no dose state; the
 * state comes from the resolver.
 */
export const ACTIVITY_LEAD_MS = 2 * 3600_000;
/** Statement windows the relay applies, less five minutes of margin. */
const START_STATEMENT_MAX_AGE_S = 30 * 24 * 3600 - 300;
const ACTIVITY_STATEMENT_MAX_AGE_S = 12 * 3600 - 300;
/** A start or update is worth nothing late. */
const PUSH_LIFETIME_S = 15 * 60;

export class ContentStateError extends Error {}

/**
 * The content state exactly as the relay accepts it: every one of the six
 * keys, no other key, each in its closed range at `nowS`. Throws
 * {@link ContentStateError} otherwise; nothing outside the template can ever
 * reach a relay item.
 */
export function relayContentState(
  input: unknown,
  nowS: number,
): RelayContentState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ContentStateError("not an object");
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.join() !== [...KEYS].sort().join()) {
    throw new ContentStateError(`keys ${keys.join()}`);
  }
  const { status, countdownTarget, timeFormatRaw } = value;
  if (!(RELAY_LA_STATUSES as readonly unknown[]).includes(status)) {
    throw new ContentStateError("status");
  }
  if (!(TIME_FORMATS as readonly unknown[]).includes(timeFormatRaw)) {
    throw new ContentStateError("timeFormatRaw");
  }
  if (
    typeof countdownTarget !== "number" ||
    !Number.isInteger(countdownTarget) ||
    (countdownTarget !== 0 &&
      (countdownTarget < nowS - COUNTDOWN_PAST_S ||
        countdownTarget > nowS + COUNTDOWN_FUTURE_S))
  ) {
    throw new ContentStateError("countdownTarget");
  }
  for (const key of ["isOverdue", "confirmed", "pendingConfirm"] as const) {
    if (typeof value[key] !== "boolean") throw new ContentStateError(key);
  }
  return {
    status: status as RelayLaStatus,
    countdownTarget,
    isOverdue: value.isOverdue as boolean,
    confirmed: value.confirmed as boolean,
    pendingConfirm: value.pendingConfirm as boolean,
    timeFormatRaw: timeFormatRaw as RelayContentState["timeFormatRaw"],
  };
}

/** Whether a stored state (key order lost in JSONB) equals `state`. */
function sameState(state: RelayContentState, stored: unknown): boolean {
  if (!stored || typeof stored !== "object") return false;
  const other = stored as Record<string, unknown>;
  return KEYS.every((key) => other[key] === state[key]);
}

/** A countdown in unix seconds, or 0 when the relay would refuse it. */
function countdown(at: Date | null, nowS: number): number {
  if (!at) return 0;
  const s = Math.floor(at.getTime() / 1000);
  return s < nowS - COUNTDOWN_PAST_S || s > nowS + COUNTDOWN_FUTURE_S ? 0 : s;
}

/** One dose an Activity shows: its slot, its resolved state, its snooze. */
export interface ActivityDose {
  medicationId: string;
  scheduledFor: Date;
  resolved: ResolvedDose;
  /** The running snooze, only when it holds this slot. */
  snoozedUntil: Date | null;
  /** The medication's Live Activity opt-in. */
  liveActivityEnabled: boolean;
}

/**
 * The content state of one dose at `now`, inside the template, or null when
 * the dose is missed: then there is nothing left to show, and the Activity
 * ends.
 *
 * `countdownTarget` is the next boundary of the dose's own band, read the
 * way the app reads it: before the target it counts down ("due in"), past it
 * it counts up ("overdue by"). Pending counts to `dueAt`; due counts to
 * `overdueSince`; overdue counts up from `overdueSince`; snoozed counts to
 * the end of the snooze.
 */
export function doseContentState(
  dose: Pick<ActivityDose, "resolved" | "snoozedUntil">,
  timeFormat: string | null | undefined,
  now: Date,
): RelayContentState | null {
  const nowS = Math.floor(now.getTime() / 1000);
  const format = (TIME_FORMATS as readonly string[]).includes(timeFormat ?? "")
    ? (timeFormat as RelayContentState["timeFormatRaw"])
    : "AUTO";
  const base = {
    confirmed: false,
    pendingConfirm: false,
    timeFormatRaw: format,
    isOverdue: false,
  };
  const { resolved } = dose;
  let state: RelayContentState;
  switch (resolved.state) {
    case "missed":
      return null;
    case "taken":
    case "taken_late":
      state = { ...base, status: "taken", countdownTarget: 0, confirmed: true };
      break;
    case "skipped":
      state = { ...base, status: "skipped", countdownTarget: 0 };
      break;
    default:
      if (dose.snoozedUntil && dose.snoozedUntil > now) {
        state = {
          ...base,
          status: "snoozed",
          countdownTarget: countdown(dose.snoozedUntil, nowS),
        };
      } else if (resolved.state === "pending") {
        state = {
          ...base,
          status: "pending",
          countdownTarget: countdown(resolved.dueAt, nowS),
        };
      } else {
        state = {
          ...base,
          status: resolved.state,
          countdownTarget: countdown(resolved.overdueSince, nowS),
          isOverdue: resolved.state === "overdue",
        };
      }
  }
  return relayContentState(state, nowS);
}

const DEVICE_SELECT = {
  ...ROUTABLE_DEVICE_SELECT,
  userId: true,
  relayBindingKey: true,
  liveActivityConsentAt: true,
  laStartToken: true,
  laStartStatement: true,
  laStartSignature: true,
  laStartedMedicationId: true,
  laStartedSlot: true,
  laStartedAt: true,
  laStartRef: true,
  liveActivities: {
    select: {
      id: true,
      pushToken: true,
      medicationId: true,
      slotInstant: true,
      activityStatement: true,
      activitySignature: true,
      lastRelayState: true,
      relayStarted: true,
    },
  },
} as const;

type LaDevice = Prisma.DeviceGetPayload<{ select: typeof DEVICE_SELECT }>;

function statementIat(statement: unknown): number | null {
  const iat = (statement as { iat?: unknown } | null)?.iat;
  return typeof iat === "number" ? iat : null;
}

/** Whether `device` may get a relay start or update now. */
export function laRelayEligible(
  device: Pick<LaDevice, "liveActivityConsentAt" | "relayBindingKey"> &
    Parameters<typeof routeOf>[0],
  ctx: PushContext,
): boolean {
  return (
    liveActivityRelayEnabled() &&
    routeOf(device, ctx) === "relay" &&
    device.liveActivityConsentAt !== null &&
    fromBase64Url(device.relayBindingKey ?? "", 32) !== null
  );
}

const SNOOZE_SCHEDULE_SELECT = {
  windowStart: true,
  windowEnd: true,
  timesOfDay: true,
  reminderGraceMinutes: true,
  doseWindows: true,
} as const;

const DOSE_ROW_SELECT = {
  id: true,
  medicationId: true,
  scheduledFor: true,
  medication: {
    select: {
      snoozedUntil: true,
      updatedAt: true,
      liveActivityEnabled: true,
      schedules: { select: SNOOZE_SCHEDULE_SELECT },
    },
  },
} as const;

type DoseRow = Prisma.MedicationIntakeEventGetPayload<{
  select: typeof DOSE_ROW_SELECT;
}>;

/**
 * The resolved doses of `rows`, in their order. A row the ledger places on
 * no slot has no dose state and is left out. The snooze is the slot's own,
 * by the rule the today list and the reminder worker share.
 */
async function resolveRows(
  userId: string,
  rows: readonly DoseRow[],
  now: Date,
): Promise<ActivityDose[]> {
  if (rows.length === 0) return [];
  const userTz = await resolveUserTimezone(userId);
  const times = rows.map((r) => r.scheduledFor.getTime());
  const resolved = await resolveDosesByRow({
    userId,
    userTz,
    medications: rows.map((r) => r.medicationId),
    takenViaByRow: new Map(),
    from: new Date(Math.min(...times)),
    to: new Date(Math.max(...times) + 1),
    now,
  });
  const held = new Map<string, Set<number>>();
  for (const row of rows) {
    if (held.has(row.medicationId)) continue;
    held.set(
      row.medicationId,
      slotsHeldBySnooze({
        snoozedUntil: row.medication.snoozedUntil,
        snoozedAt: row.medication.updatedAt,
        schedules: row.medication.schedules,
        slotInstants: rows
          .filter((r) => r.medicationId === row.medicationId)
          .map((r) => r.scheduledFor),
        tz: userTz,
        now,
      }),
    );
  }
  return rows.flatMap((row) => {
    const dose = resolved.get(row.id);
    if (!dose) return [];
    const holds = held.get(row.medicationId)?.has(row.scheduledFor.getTime());
    return [
      {
        medicationId: row.medicationId,
        scheduledFor: row.scheduledFor,
        resolved: dose,
        snoozedUntil: holds ? row.medication.snoozedUntil : null,
        liveActivityEnabled: row.medication.liveActivityEnabled,
      },
    ];
  });
}

async function doseAt(
  userId: string,
  medicationId: string,
  slot: Date,
  now: Date,
): Promise<ActivityDose | null> {
  const row = await prisma.medicationIntakeEvent.findFirst({
    where: {
      userId,
      medicationId,
      scheduledFor: activitySlotWindow(slot),
      deletedAt: null,
    },
    orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
    select: DOSE_ROW_SELECT,
  });
  if (!row) return null;
  const [dose] = await resolveRows(userId, [row], now);
  return dose ?? null;
}

/**
 * The open tracked doses an Activity may show at `now`, soonest first: the
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
 * The one dose the pass starts an Activity for, or null: of the startable
 * doses, the earliest slot; on a tie the lowest medication id, so the
 * choice never depends on the order the rows were read in.
 */
export function pickStartDose<
  T extends Pick<
    ActivityDose,
    "medicationId" | "scheduledFor" | "resolved" | "liveActivityEnabled"
  >,
>(doses: readonly T[], now: Date): T | null {
  let best: T | null = null;
  for (const dose of doses) {
    if (!startableDose(dose, now)) continue;
    if (
      !best ||
      dose.scheduledFor.getTime() < best.scheduledFor.getTime() ||
      (dose.scheduledFor.getTime() === best.scheduledFor.getTime() &&
        dose.medicationId < best.medicationId)
    ) {
      best = dose;
    }
  }
  return best;
}

export interface LaPassFacts {
  devices: number;
  started: number;
  updated: number;
  /** Devices whose run threw; the pass carried on past each. */
  failed: number;
}

/** The start item for `device`'s dose to start, or null when none is. */
async function startItem(
  device: LaDevice,
  timeFormat: string | null,
  now: Date,
): Promise<{ item: RelayItemInput; dose: ActivityDose } | null> {
  const nowS = Math.floor(now.getTime() / 1000);
  const iat = statementIat(device.laStartStatement);
  if (
    !device.laStartToken ||
    !device.laStartSignature ||
    iat === null ||
    nowS - iat > START_STATEMENT_MAX_AGE_S
  ) {
    return null;
  }
  const dose = pickStartDose(await openActivityDoses(device.userId, now), now);
  if (!dose) return null;
  const state = doseContentState(dose, timeFormat, now);
  if (!state) return null;
  const slot = dose.scheduledFor.getTime();
  // Once per dose: a start the relay accepted, or one still in flight. A
  // start that failed for good no longer holds the dose
  // (`live-activity-settle.ts`), and one whose outbox row is gone is no
  // start at all.
  if (
    device.laStartedMedicationId === dose.medicationId &&
    device.laStartedSlot?.getTime() === slot &&
    (device.laStartedAt !== null ||
      (await startHeld(device.id, device.laStartRef)))
  ) {
    return null;
  }
  if (await refusedRecently(device.id, LA_START_EVENT, now)) return null;
  const running = device.liveActivities.some(
    (a) =>
      a.medicationId === dose.medicationId &&
      (a.slotInstant === null ||
        sameActivitySlot(a.slotInstant, dose.scheduledFor)),
  );
  if (running) return null;
  return {
    dose,
    item: {
      deviceId: device.id,
      ref: `las-${newUlid(now.getTime())}`,
      pushClass: "liveactivity",
      eventType: LA_START_EVENT,
      activity: {
        event: "start",
        state,
        token: device.laStartToken,
        bindingKey: device.relayBindingKey as string,
        statement: device.laStartStatement as Record<string, unknown>,
        signature: device.laStartSignature,
      },
      expiresAt: new Date((nowS + PUSH_LIFETIME_S) * 1000),
    },
  };
}

type LaActivity = LaDevice["liveActivities"][number];

/**
 * Who started a registered Activity: the relay, by a push-to-start
 * (`HealthLogDoseAttributes`, registered with `relayStart: true`, the dose
 * the device's `liveActivityStarted` names), or the app itself
 * (`MedicationActivityAttributes`). The mark is kept per token
 * (`relayStarted`, migration 0545) and never changes for an Activity.
 */
export type RelayActivityKind = "relay_started" | "app_started";

export function relayActivityKind(activity: {
  relayStarted: boolean;
}): RelayActivityKind {
  return activity.relayStarted ? "relay_started" : "app_started";
}

/**
 * Whether the relay may send `event` to a registered Activity of this kind.
 * Every relay update is built through {@link relayUpdateItem}, which asks
 * this; the end path (`endActivitiesOverRelay`) ends every kind.
 *
 * An end goes to both kinds: the relay writes its own fixed content state
 * into an end (`status: "taken"`, `countdownTarget: 0`, a `dismissal-date`
 * of now; the server may send no state with it), and both attributes types
 * hide the countdown for a taken dose and dismiss at once.
 *
 * An update goes only to an Activity the relay started. The relay template
 * carries `countdownTarget` in unix seconds, which `HealthLogDoseAttributes`
 * reads; `MedicationActivityAttributes` reads it as seconds since
 * 2001-01-01, so an update showed an app-started Activity a time 31 years
 * off. The relay's bounds (one day back, two days ahead of its clock, or 0)
 * leave no room to send it reference-date seconds instead. iOS builds before
 * the next 1.7 build read app-started Activities in reference-date seconds;
 * relaxing this waits until those builds are gone (1.50 at the earliest).
 */
export function relayEventAllowed(
  kind: RelayActivityKind,
  event: "update" | "end",
): boolean {
  return event === "end" || kind === "relay_started";
}

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
                  .map((a) => a.medicationId),
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
  const [inFlight, refused] = relayStarted
    ? await Promise.all([
        updatesInFlight(device.id),
        refusedRecently(device.id, LA_UPDATE_EVENT, now),
      ])
    : [new Set<string>(), false];
  for (const activity of device.liveActivities) {
    const iat = statementIat(activity.activityStatement);
    if (
      !activity.slotInstant ||
      !activity.activitySignature ||
      iat === null ||
      nowS - iat > ACTIVITY_STATEMENT_MAX_AGE_S
    ) {
      continue;
    }
    if (relayOwned(activity) && !startable.has(activity.medicationId)) {
      ending.push(activity);
      continue;
    }
    const dose = await doseAt(
      device.userId,
      activity.medicationId,
      activity.slotInstant,
      now,
    );
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

/** Start and update the Live Activities of one device. */
export async function runDeviceLiveActivities(
  device: LaDevice,
  ctx: PushContext,
  now: Date,
): Promise<{ started: number; updated: number }> {
  if (!laRelayEligible(device, ctx)) return { started: 0, updated: 0 };
  if (await pendingDeletionOf(device.userId)) return { started: 0, updated: 0 };
  const user = await prisma.user.findUnique({
    where: { id: device.userId },
    select: { timeFormat: true },
  });
  const timeFormat = user?.timeFormat ?? null;
  const start = await startItem(device, timeFormat, now);
  const { updates, ending } = await updateItems(device, timeFormat, now);
  if (ending.length > 0) {
    // A missed dose has nothing left to show, and a medication without the
    // opt-in gets no server-started Activity: end it, and forget the token
    // once the relay took the end or reported the Activity gone.
    const spent = await endActivitiesOverRelay(device, ending, ctx);
    if (spent.length > 0) {
      await prisma.liveActivityToken.deleteMany({
        where: { id: { in: spent } },
      });
    }
  }
  const items = [...(start ? [start.item] : []), ...updates.map((u) => u.item)];
  if (items.length === 0) return { started: 0, updated: 0 };
  if (start) {
    // The dose is held while the start is in flight; `laStartedAt` follows
    // only when the relay accepts it, and a failure for good clears the
    // dose again (`live-activity-settle.ts`, run by the outbox).
    await prisma.device.update({
      where: { id: device.id },
      data: {
        laStartedMedicationId: start.dose.medicationId,
        laStartedSlot: start.dose.scheduledFor,
        laStartedAt: null,
        laStartRef: start.item.ref,
      },
    });
  }
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

/** The pass over every device that may get a relay start or update. */
export async function runLiveActivityRelayPass(
  now: Date = new Date(),
): Promise<LaPassFacts> {
  const facts: LaPassFacts = { devices: 0, started: 0, updated: 0, failed: 0 };
  if (!liveActivityRelayEnabled()) return facts;
  const ctx = await loadPushContext();
  if (!ctx.registration?.instanceId) return facts;
  const where = {
    relayState: "bound",
    relayConsentAt: { not: null },
    liveActivityConsentAt: { not: null },
    apnsToken: { not: null },
    pushKeyPublic: { not: null },
  } as const;
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
  for (const device of devices) {
    facts.devices += 1;
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
  return facts;
}

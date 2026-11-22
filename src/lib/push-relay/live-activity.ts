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
 * the next open dose of each eligible device, once per dose, unless the
 * device already runs one for it; and it updates every running Activity
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

export interface LaPassFacts {
  devices: number;
  started: number;
  updated: number;
  /** Devices whose run threw; the pass carried on past each. */
  failed: number;
}

/** The start item for `device`'s next dose, or null when none is due. */
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
  const [dose] = await openActivityDoses(device.userId, now);
  if (!dose) return null;
  const state = doseContentState(dose, timeFormat, now);
  if (!state) return null;
  const slot = dose.scheduledFor.getTime();
  if (
    device.laStartedMedicationId === dose.medicationId &&
    device.laStartedSlot?.getTime() === slot
  ) {
    return null;
  }
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
      eventType: "LIVE_ACTIVITY_START",
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
 * The update items for `device`'s running Activities whose state changed,
 * and the Activities whose dose the resolver calls missed: those end.
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
  missed: LaActivity[];
}> {
  const nowS = Math.floor(now.getTime() / 1000);
  const updates = [];
  const missed: LaActivity[] = [];
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
      missed.push(activity);
      continue;
    }
    if (!activity.relayStarted) continue;
    if (sameState(state, activity.lastRelayState)) continue;
    updates.push({
      rowId: activity.id,
      state,
      item: {
        deviceId: device.id,
        ref: `lau-${newUlid(now.getTime())}`,
        pushClass: "liveactivity" as const,
        eventType: "LIVE_ACTIVITY_UPDATE",
        activity: {
          event: "update" as const,
          state,
          token: activity.pushToken.toLowerCase(),
          bindingKey: device.relayBindingKey as string,
          statement: activity.activityStatement as Record<string, unknown>,
          signature: activity.activitySignature,
        },
        expiresAt: new Date((nowS + PUSH_LIFETIME_S) * 1000),
      },
    });
  }
  return { updates, missed };
}

/** Refs of items the relay accepted or still holds for a retry. */
async function liveRefs(
  deviceId: string,
  refs: string[],
): Promise<Set<string>> {
  if (refs.length === 0) return new Set();
  const rows = await prisma.pushRelayDelivery.findMany({
    where: {
      deviceId,
      ref: { in: refs },
      status: { in: ["accepted", "pending"] },
    },
    select: { ref: true },
  });
  return new Set(rows.map((r) => r.ref));
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
  const { updates, missed } = await updateItems(device, timeFormat, now);
  if (missed.length > 0) {
    // A missed dose has nothing left to show: end its Activity, and forget
    // the token once the relay took the end or reported the Activity gone.
    const spent = await endActivitiesOverRelay(device, missed, ctx);
    if (spent.length > 0) {
      await prisma.liveActivityToken.deleteMany({
        where: { id: { in: spent } },
      });
    }
  }
  const items = [...(start ? [start.item] : []), ...updates.map((u) => u.item)];
  if (items.length === 0) return { started: 0, updated: 0 };
  const summary = await sendRelayItems(items, ctx.config);
  const sent = await liveRefs(
    device.id,
    items.map((i) => i.ref),
  );
  let started = 0;
  if (start && sent.has(start.item.ref)) {
    started = 1;
    await prisma.device.update({
      where: { id: device.id },
      data: {
        laStartedMedicationId: start.dose.medicationId,
        laStartedSlot: start.dose.scheduledFor,
        laStartedAt: now,
      },
    });
  }
  let updated = 0;
  for (const u of updates) {
    if (summary.activityGone.includes(u.item.ref)) {
      await prisma.liveActivityToken.deleteMany({ where: { id: u.rowId } });
    } else if (sent.has(u.item.ref)) {
      updated += 1;
      await prisma.liveActivityToken.update({
        where: { id: u.rowId },
        data: { lastRelayState: { ...u.state } },
      });
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

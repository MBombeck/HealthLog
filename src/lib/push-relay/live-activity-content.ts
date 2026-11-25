/**
 * The relay's Live Activity content-state template and the state one dose
 * shows in it. Pure: no database, no send. The pass in `live-activity.ts`
 * builds every start and update from here.
 */
import type { ResolvedDose } from "@/lib/medications/dose-state/resolve";

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
export const COUNTDOWN_PAST_S = 24 * 3600;
const COUNTDOWN_FUTURE_S = 48 * 3600;
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
export function sameState(state: RelayContentState, stored: unknown): boolean {
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

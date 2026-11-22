/**
 * Pushes handed to the relay: the outbox, the batch call, and what each
 * per-item answer does (`spec/protocol.md`, "Results" and "Failure handling").
 *
 * Every item is written to `push_relay_deliveries` first, with its sealed
 * envelope and its deadline (`expiresAt`, the plaintext `exp`). A retry sends
 * that same envelope under the same `ref`, so the relay's idempotency returns
 * the first result instead of sending twice, and nothing is ever sealed
 * again. An item past its deadline is dropped and counted
 * (`push.relay.stale_dropped`), never delivered late.
 *
 * What an answer does ({@link classifyRelayAnswer}, the one reading of a
 * result code). Only `200 accepted` is a delivery: the relay answers `200`
 * for the batch and refuses items inside it, so no caller reads the batch
 * status, only each item's outcome ({@link RelayItemOutcome}).
 * - `accepted`: done; the ledger row waits for the device's receipt.
 * - a budget refusal (`429`: `device_quota`, `binding_quota`,
 *   `instance_quota`, `instance_rate`, `global`): an alert or a Live Activity
 *   push waits for the relay's signed `retryAfter` and is tried again until
 *   its deadline. A silent push is not retried: the relay holds the device's
 *   silent pushes until then, and the push is owed instead (`owed-silent.ts`):
 *   the intake sync coalesces into the one sync the device is owed, a
 *   `DATA_CHANGED` wake puts its domains back. The minute pass sends a fresh
 *   one once the hold ends.
 * - a transient answer (`503`: `apns_unavailable`, `maintenance`,
 *   `queue_full`, `relay_misconfigured`; any other 5xx but `502`; a transport
 *   failure): retried with backoff until the deadline. A retry that could
 *   only come after the deadline drops the push at once, and the summary
 *   counts it under the code `deadline` as owed (a silent push) or failed,
 *   never as waiting.
 * - `soft_invalid`, `activity_gone`, `apns_rejected`, `invalid_item`,
 *   `activity_refused`: final for this push; nothing is deleted.
 * - `404 binding_unknown`: the device must bind again (`rebind_needed`).
 * - `410 unregistered`: Apple says the app is gone. The only answer that
 *   deletes the device row, and only below the server-side cap: more than a
 *   third of the relay devices in one hour holds every further deletion for
 *   24 hours, because that pattern is a relay or Apple defect, not a wave of
 *   uninstalls.
 * - a silent push dropped at its deadline is owed again, like one refused
 *   for a budget.
 *
 * Nothing here records a channel failure: a relay or Apple outage never
 * counts against a device or a notification channel.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { deleteDeviceRows } from "@/lib/devices/delete-devices";
import { getEvent } from "@/lib/logging/context";
import { relayConfig, type RelayConfig } from "@/lib/push-relay/config";
import { isCircuitOpen } from "@/lib/push-relay/circuit";
import type { EnvelopeMessage } from "@/lib/push-relay/envelope";
import { settleLiveActivityPush } from "@/lib/push-relay/live-activity-settle";
import {
  oweIntakeSync,
  owePendingDomains,
  relayHoldUntil,
} from "@/lib/push-relay/owed-silent";
import { MAX_RETRY_AFTER_S } from "@/lib/push-relay/responses";
import {
  loadRegistration,
  relayCall,
  type RegistrationRow,
} from "@/lib/push-relay/registration";

export type RelayPushClass = "alert" | "silent" | "liveactivity";

export interface RelayActivity {
  /** `start` or `update`; absent for an end (the relay's default). */
  event?: "start" | "update";
  /** The closed content state (`live-activity.ts`); start and update only. */
  state?: Readonly<Record<string, string | number | boolean>>;
  token: string;
  bindingKey: string;
  statement: Record<string, unknown>;
  signature: string;
}

export interface RelayItemInput {
  deviceId: string;
  ref: string;
  pushClass: RelayPushClass;
  eventType: string;
  envelope?: string;
  collapse?: string;
  activity?: RelayActivity;
  expiresAt: Date;
  /**
   * `DATA_CHANGED` only: the domains the wake announces, kept beside the
   * envelope (never on the wire), so a wake the relay refuses or drops puts
   * them back for the next one.
   */
  domains?: readonly string[];
}

/**
 * What became of one item in this attempt:
 * - `accepted`: Apple has it;
 * - `waiting`: the outbox tries it again (a transient answer, an alert's or
 *   Live Activity push's budget refusal, the relay unreachable or paused);
 * - `owed`: a silent push the relay refused for a budget, or dropped at its
 *   deadline; the minute pass sends a fresh one (`owed-silent.ts`);
 * - `failed`: final without delivery.
 */
export type RelayItemOutcome = "accepted" | "waiting" | "owed" | "failed";

export interface RelaySendSummary {
  accepted: number;
  /** Items that will be retried or wait for the relay. */
  waiting: number;
  /** Silent items owed to their device, sent afresh by the minute pass. */
  owed: number;
  /** Items that are final without delivery. */
  failed: number;
  /** Each item's outcome, by `ref`: every item of the attempt has one. */
  byRef: Record<string, RelayItemOutcome>;
  /** Live Activity rows whose token the relay or Apple reported gone. */
  activityGone: string[];
  /**
   * What the relay answered per item, by `ref`: only answers that carried a
   * valid relay signature get here; anything else is `transport`.
   */
  answers: RelayItemAnswer[];
  /**
   * How many items ended this attempt with each code: the relay's per-item
   * `result` or `error`, the request's refusal, the transport reason, or the
   * local decision (`deadline`, `not_bound`, `relay_unavailable`,
   * `relay_paused`). Every item counts once, so a send is never reported
   * without its reason; it also goes into the wide event as
   * `push_relay_send_results`.
   */
  outcomes: Record<string, number>;
}

export interface RelayItemAnswer {
  ref: string;
  /** HTTP status of the item, or of the request when it failed as a whole; 0 for no signed answer. */
  status: number;
  /** `result` or `error` of the item, or the transport reason. */
  code: string;
  reason: string | null;
}

const BATCH = 50;
const SECOND = 1000;

/**
 * The one lifetime every sealed push of a class gets over the relay. The
 * relay reads `ttlSeconds` in the clear beside the envelope (it becomes
 * `apns-expiration`), so a lifetime per kind would tell it a reminder from a
 * dose confirmation from a security alert. One value per class leaves it the
 * class alone, which it knows anyway. The envelope's own `exp` is the same
 * value, so a push never outlives what the app accepts.
 *
 * Alerts get the reminder's 15 minutes: a reminder later than that is stale,
 * and every other alert is either shown elsewhere too or replaced by a newer
 * one. Silent pushes get the hour every silent kind already had. A Live
 * Activity push is not listed: its event (`end`, `start`, `update`) rides in
 * the clear anyway, so its lifetime follows the event.
 */
export const RELAY_CLASS_LIFETIME_S = Object.freeze({
  alert: 15 * 60,
  silent: 3600,
} as const);

/** `message` as it travels over the relay: with its class's one lifetime. */
export function overRelay(message: EnvelopeMessage): EnvelopeMessage {
  return {
    ...message,
    lifetimeSeconds: RELAY_CLASS_LIFETIME_S[message.pushClass],
  };
}

/** The step the remaining lifetime is rounded down to on the wire. */
const WIRE_TTL_STEP_S = 60;

/**
 * Retry delays in seconds per class, before jitter. One schedule per class,
 * for the same reason as the lifetime: during an outage the retry pattern is
 * visible to the relay, and it must not differ by kind.
 */
function backoffSeconds(pushClass: RelayPushClass): number[] {
  if (pushClass === "liveactivity") return [5, 30, 120, 600];
  if (pushClass === "silent") return [30, 120, 600, 1800];
  return [5, 20, 60, 180, 480, 600];
}

/**
 * `ttlSeconds` on the wire: what is left of the push's lifetime, rounded
 * down to whole minutes, so the value says nothing finer than the minute a
 * push was sealed in. Never below a minute: the app still opens an envelope
 * up to 300 s past its `exp`.
 */
function wireTtlSeconds(expiresAt: Date, now: Date): number {
  const left = Math.floor((expiresAt.getTime() - now.getTime()) / SECOND);
  return Math.max(
    WIRE_TTL_STEP_S,
    Math.floor(left / WIRE_TTL_STEP_S) * WIRE_TTL_STEP_S,
  );
}

/** The next attempt after `attempts` failures, jittered by 20 %. */
export function nextAttemptAt(
  pushClass: RelayPushClass,
  attempts: number,
  now: Date,
  hintSeconds: number | null = null,
): Date {
  const schedule = backoffSeconds(pushClass);
  const base =
    hintSeconds ?? schedule[Math.min(attempts, schedule.length - 1)] ?? 60;
  const jitter = hintSeconds === null ? 0.8 + Math.random() * 0.4 : 1;
  return new Date(now.getTime() + Math.max(1, base * jitter) * SECOND);
}

/** Write the items to the outbox and try them at once. */
export async function sendRelayItems(
  items: RelayItemInput[],
  config: RelayConfig = relayConfig(),
): Promise<RelaySendSummary> {
  if (items.length === 0) return emptySummary();
  const now = new Date();
  await prisma.pushRelayDelivery.createMany({
    data: items.map((item) => ({
      deviceId: item.deviceId,
      ref: item.ref,
      pushClass: item.pushClass,
      eventType: item.eventType,
      item: {
        ...(item.envelope ? { envelope: item.envelope } : {}),
        ...(item.collapse ? { collapse: item.collapse } : {}),
        ...(item.activity
          ? {
              activity: {
                ...item.activity,
                statement: item.activity.statement as Prisma.InputJsonObject,
                ...(item.activity.state
                  ? { state: { ...item.activity.state } }
                  : {}),
              },
            }
          : {}),
        ...(item.domains ? { domains: [...item.domains] } : {}),
      },
      expiresAt: item.expiresAt,
      nextAttemptAt: now,
    })),
    skipDuplicates: true,
  });
  const rows = await prisma.pushRelayDelivery.findMany({
    where: {
      status: "pending",
      OR: items.map((i) => ({ deviceId: i.deviceId, ref: i.ref })),
    },
    select: { id: true },
  });
  return attemptDeliveries(
    rows.map((r) => r.id),
    config,
  );
}

type PendingRow = Awaited<ReturnType<typeof loadPending>>[number];

function loadPending(ids: string[]) {
  return prisma.pushRelayDelivery.findMany({
    where: { id: { in: ids }, status: "pending" },
    select: {
      id: true,
      ref: true,
      pushClass: true,
      eventType: true,
      item: true,
      expiresAt: true,
      attempts: true,
      device: {
        select: {
          id: true,
          apnsToken: true,
          apnsEnvironment: true,
          relayState: true,
        },
      },
    },
  });
}

/**
 * Make a push final. What depends on its answer is settled here, the one
 * place every final answer passes: a Live Activity start or update counts
 * as done only once accepted (`live-activity-settle.ts`). `holdUntil` is
 * kept only on a silent push the relay refused for a budget: the relay's
 * hold on the device's silent pushes (`owed-silent.ts`).
 */
async function finish(
  row: PendingRow,
  status: "accepted" | "dropped" | "failed",
  reason: string | null,
  holdUntil: Date | null = null,
) {
  const now = new Date();
  await prisma.pushRelayDelivery.update({
    where: { id: row.id },
    data: {
      status,
      reason,
      item: Prisma.DbNull,
      nextAttemptAt: holdUntil,
      ...(status === "accepted" ? { acceptedAt: now } : {}),
    },
  });
  if (row.pushClass === "liveactivity") {
    await settleLiveActivityPush(
      {
        deviceId: row.device.id,
        ref: row.ref,
        eventType: row.eventType,
        item: row.item,
      },
      status,
      now,
    );
  }
}

/** The silent sync that makes the app re-read the doses. */
const INTAKE_SYNC_EVENT = "MEDICATION_INTAKE_SYNC";
const DATA_CHANGED_EVENT = "DATA_CHANGED";

/** Codes that name a budget, whatever status carries them. */
const BUDGET_CODES = new Set([
  "device_quota",
  "binding_quota",
  "instance_quota",
  "instance_rate",
  "global",
  "silent_budget",
  "rate_limited",
]);
/** Codes that name a passing outage of the relay or Apple. */
const TRANSIENT_CODES = new Set([
  "apns_unavailable",
  "maintenance",
  "queue_full",
  "relay_misconfigured",
  "overloaded",
  "storage_unavailable",
]);

export type RelayAnswerClass =
  "accepted" | "budget" | "transient" | "rebind" | "unregistered" | "final";

/**
 * The one reading of a relay item's answer (`spec/protocol.md`, "Results",
 * "Per item"): `status` 0 is an item without a signed answer. Only `200
 * accepted` is a delivery; every other answer is a budget to wait out, an
 * outage to retry, or final.
 */
export function classifyRelayAnswer(
  status: number,
  code: string,
): RelayAnswerClass {
  if (status === 200 && code === "accepted") return "accepted";
  if (code === "binding_unknown") return "rebind";
  if (status === 410 && code === "unregistered") return "unregistered";
  if (status === 429 || BUDGET_CODES.has(code)) return "budget";
  if (
    status === 0 ||
    (status >= 500 && status !== 502) ||
    TRANSIENT_CODES.has(code)
  ) {
    return "transient";
  }
  return "final";
}

function emptySummary(): RelaySendSummary {
  return {
    accepted: 0,
    waiting: 0,
    owed: 0,
    failed: 0,
    byRef: {},
    activityGone: [],
    answers: [],
    outcomes: {},
  };
}

/** Count one item under its outcome. */
function mark(
  summary: RelaySendSummary,
  row: { ref: string },
  outcome: RelayItemOutcome,
) {
  summary.byRef[row.ref] = outcome;
  summary[outcome] += 1;
}

/**
 * A silent push that did not go is owed to its device: an intake sync folds
 * into the one sync the device is owed, a `DATA_CHANGED` wake puts its
 * domains back. The state it announced is still unread there, and the next
 * change may be hours away.
 */
async function oweAgain(row: PendingRow, now: Date) {
  if (row.eventType === INTAKE_SYNC_EVENT) {
    await oweIntakeSync([row.device.id], now);
    return;
  }
  const domains = (row.item as { domains?: unknown } | null)?.domains;
  if (row.eventType === DATA_CHANGED_EVENT && Array.isArray(domains)) {
    const list = domains.filter((d): d is string => typeof d === "string");
    if (list.length > 0) await owePendingDomains(row.device.id, list, now);
  }
}

/**
 * Drop a push whose deadline has passed, or would pass before it could be
 * tried again. A silent one is owed again; anything else failed.
 */
async function dropAtDeadline(
  row: PendingRow,
  now: Date,
  summary: RelaySendSummary,
) {
  await finish(row, "dropped", "deadline");
  getEvent()?.addMeta("push_relay_stale_dropped", true);
  count(summary, "deadline");
  if (row.pushClass === "silent") {
    await oweAgain(row, now);
    mark(summary, row, "owed");
    return;
  }
  mark(summary, row, "failed");
}

/**
 * A silent push the relay refused for a budget: not retried, owed. Its row
 * keeps the relay's hold, so no silent push to the device goes before it.
 */
async function oweForBudget(
  row: PendingRow,
  now: Date,
  hint: number | null,
  code: string,
  summary: RelaySendSummary,
) {
  const until = await relayHoldUntil(row.device.id, now, hint);
  await finish(row, "dropped", reasonCode(code), until);
  await oweAgain(row, now);
  mark(summary, row, "owed");
}

/**
 * Schedule the next attempt, or drop the push when that attempt would come
 * after its deadline: then it counts as owed (silent) or failed, never as
 * waiting.
 */
async function retryLater(
  row: PendingRow,
  now: Date,
  hint: number | null,
  code: string,
  summary: RelaySendSummary,
) {
  const at = nextAttemptAt(
    row.pushClass as RelayPushClass,
    row.attempts,
    now,
    hint,
  );
  if (at >= row.expiresAt) {
    await dropAtDeadline(row, now, summary);
    return;
  }
  await prisma.pushRelayDelivery.update({
    where: { id: row.id },
    // A waiting push keeps the code it waits on as its reason, so the
    // ledger and the diagnostics say why it has not gone yet
    // (`bad_signature`, a quota, the relay unreachable).
    data: {
      attempts: { increment: 1 },
      nextAttemptAt: at,
      reason: reasonCode(code),
    },
  });
  mark(summary, row, "waiting");
}

/** Hold everything until the relay can take it again. */
async function holdAll(
  rows: PendingRow[],
  until: Date,
  reason: string,
  summary: RelaySendSummary,
) {
  await prisma.pushRelayDelivery.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { nextAttemptAt: until, reason },
  });
  for (const row of rows) mark(summary, row, "waiting");
  count(summary, reason, rows.length);
}

/** Try the given pending deliveries now. */
export async function attemptDeliveries(
  ids: string[],
  config: RelayConfig = relayConfig(),
): Promise<RelaySendSummary> {
  const summary = emptySummary();
  try {
    await attemptInto(summary, ids, config);
  } finally {
    noteOutcomes(summary.outcomes);
  }
  return summary;
}

/**
 * Count one item's outcome under its code. The relay names most codes, so
 * one that is not a plain snake_case word is counted as `unrecognised`
 * rather than written into a log key verbatim.
 */
function reasonCode(code: string): string {
  return /^[a-z][a-z0-9_]{0,39}$/.test(code) ? code : "unrecognised";
}

function count(summary: RelaySendSummary, code: string, n = 1) {
  const key = reasonCode(code);
  summary.outcomes[key] = (summary.outcomes[key] ?? 0) + n;
}

const eventOutcomes = new WeakMap<object, Record<string, number>>();

/**
 * Add these outcomes to the wide event's `push_relay_send_results`, summed
 * over every send the event saw (a flush can send more than once).
 */
function noteOutcomes(outcomes: Record<string, number>) {
  const evt = getEvent();
  if (!evt || Object.keys(outcomes).length === 0) return;
  const total = eventOutcomes.get(evt) ?? {};
  for (const [code, n] of Object.entries(outcomes)) {
    total[code] = (total[code] ?? 0) + n;
  }
  eventOutcomes.set(evt, total);
  evt.addMeta("push_relay_send_results", { ...total });
}

async function attemptInto(
  summary: RelaySendSummary,
  ids: string[],
  config: RelayConfig,
): Promise<void> {
  const now = new Date();
  const registration = config.available ? await loadRegistration(config) : null;
  const pending = await loadPending(ids);
  const live: PendingRow[] = [];
  for (const row of pending) {
    if (row.expiresAt <= now) {
      await dropAtDeadline(row, now, summary);
    } else if (!row.device.apnsToken || row.device.relayState !== "bound") {
      await finish(row, "failed", "not_bound");
      mark(summary, row, "failed");
      count(summary, "not_bound");
    } else {
      live.push(row);
    }
  }
  if (live.length === 0) return;
  if (!registration?.instanceId || isCircuitOpen(registration)) {
    await holdAll(
      live,
      registration?.nextProbeAt ?? new Date(now.getTime() + 60 * SECOND),
      "relay_unavailable",
      summary,
    );
    return;
  }
  if (registration.pausedUntil && registration.pausedUntil > now) {
    await holdAll(live, registration.pausedUntil, "relay_paused", summary);
    return;
  }
  for (let i = 0; i < live.length; i += BATCH) {
    await sendBatch(registration, live.slice(i, i + BATCH), summary, config);
  }
}

function wireItem(row: PendingRow, now: Date) {
  const item = (row.item ?? {}) as Record<string, unknown>;
  return {
    ref: row.ref,
    token: (row.device.apnsToken as string).toLowerCase(),
    env: row.device.apnsEnvironment === "sandbox" ? "sandbox" : "production",
    class: row.pushClass,
    ttlSeconds: wireTtlSeconds(row.expiresAt, now),
    ...(item.envelope ? { envelope: item.envelope } : {}),
    ...(item.collapse ? { collapse: item.collapse } : {}),
    ...(item.activity ? { activity: item.activity } : {}),
  };
}

async function sendBatch(
  registration: RegistrationRow,
  rows: PendingRow[],
  summary: RelaySendSummary,
  config: RelayConfig,
) {
  const now = new Date();
  const result = await relayCall(
    registration,
    "POST",
    "/v1/push",
    { items: rows.map((row) => wireItem(row, now)) },
    config,
  );
  // Meta, not an action: a send can run inside the request that caused it,
  // and must not rename that request's event.
  getEvent()?.addMeta("push_relay_send_items", rows.length);
  getEvent()?.addMeta(
    "push_relay_send_status",
    result.kind === "transport" ? 0 : result.status,
  );
  if (result.kind === "transport" || result.status !== 200) {
    const hint = result.kind === "response" ? result.retryAfter : null;
    const defect =
      result.kind === "response" &&
      (result.status === 413 || result.status === 422);
    const code =
      result.kind === "transport"
        ? result.reason
        : String(result.body?.error ?? "refused");
    for (const row of rows) {
      summary.answers.push({
        ref: row.ref,
        status: result.kind === "transport" ? 0 : result.status,
        code,
        reason: null,
      });
      count(summary, code);
      if (defect) {
        await finish(
          row,
          "failed",
          String(result.body?.error ?? "invalid_item"),
        );
        mark(summary, row, "failed");
      } else if (
        row.pushClass === "silent" &&
        result.kind === "response" &&
        classifyRelayAnswer(result.status, code) === "budget"
      ) {
        await oweForBudget(row, now, hint, code, summary);
      } else {
        // Anything else the whole request was refused with waits: an outage,
        // and also `bad_signature`, which waits for a fix on this side.
        await retryLater(row, now, hint, code, summary);
      }
    }
    if (defect) getEvent()?.addWarning("push_relay_request_refused_as_invalid");
    return;
  }
  const results = Array.isArray(result.body?.results)
    ? (result.body.results as Array<Record<string, unknown>>)
    : [];
  for (const row of rows) {
    const answer = results.find((r) => r.ref === row.ref);
    await applyItemResult(registration, row, answer ?? null, now, summary);
  }
}

async function applyItemResult(
  registration: RegistrationRow,
  row: PendingRow,
  answer: Record<string, unknown> | null,
  now: Date,
  summary: RelaySendSummary,
) {
  const status = typeof answer?.status === "number" ? answer.status : 0;
  const code = String(answer?.result ?? answer?.error ?? "missing");
  const hint =
    typeof answer?.retryAfter === "number"
      ? Math.min(answer.retryAfter, MAX_RETRY_AFTER_S)
      : null;
  summary.answers.push({
    ref: row.ref,
    status,
    code,
    reason: typeof answer?.reason === "string" ? answer.reason : null,
  });
  count(summary, code);
  const kind = classifyRelayAnswer(status, code);
  if (kind === "accepted") {
    await finish(row, "accepted", null);
    mark(summary, row, "accepted");
    return;
  }
  if (status === 200 && code === "activity_gone") {
    summary.activityGone.push(row.ref);
  }
  if (kind === "rebind") {
    await prisma.device.update({
      where: { id: row.device.id },
      data: { relayState: "rebind_needed", relayBoundAt: null },
    });
  }
  if (kind === "unregistered") {
    await releaseUnregistered(registration, row.device.id, now);
    mark(summary, row, "failed");
    return;
  }
  if (kind === "budget" && row.pushClass === "silent") {
    await oweForBudget(row, now, hint, code, summary);
    return;
  }
  if (kind === "budget" || kind === "transient") {
    await retryLater(row, now, hint, code, summary);
    return;
  }
  await finish(row, "failed", code.slice(0, 40));
  mark(summary, row, "failed");
}

/**
 * Apple reported the device token as unregistered: delete the device row,
 * unless deletions in the last hour already reach a third of the relay
 * devices, which holds every further deletion for 24 hours.
 */
async function releaseUnregistered(
  registration: RegistrationRow,
  deviceId: string,
  now: Date,
) {
  const fresh = await prisma.pushRelayRegistration.findUnique({
    where: { id: registration.id },
    select: {
      unregisteredSince: true,
      unregisteredCount: true,
      deletionHoldUntil: true,
    },
  });
  const windowOpen =
    fresh?.unregisteredSince &&
    now.getTime() - fresh.unregisteredSince.getTime() < 3600 * SECOND;
  const count = (windowOpen ? (fresh?.unregisteredCount ?? 0) : 0) + 1;
  // The relay devices as the hour began: those with relay consent now, plus
  // the ones this window already deleted.
  const relayDevices =
    (await prisma.device.count({ where: { relayConsentAt: { not: null } } })) +
    (count - 1);
  const held =
    (fresh?.deletionHoldUntil && fresh.deletionHoldUntil > now) ||
    (relayDevices >= 3 && count > Math.floor(relayDevices / 3));
  await prisma.pushRelayRegistration.update({
    where: { id: registration.id },
    data: {
      unregisteredSince: windowOpen ? fresh?.unregisteredSince : now,
      unregisteredCount: count,
      ...(held && !(fresh?.deletionHoldUntil && fresh.deletionHoldUntil > now)
        ? { deletionHoldUntil: new Date(now.getTime() + 24 * 3600 * SECOND) }
        : {}),
    },
  });
  if (held) {
    getEvent()?.addWarning("push_relay_unregistered_deletion_held");
    await prisma.device.update({
      where: { id: deviceId },
      data: { relayState: "rebind_needed", relayBoundAt: null },
    });
    return;
  }
  await deleteDeviceRows({ id: deviceId });
}

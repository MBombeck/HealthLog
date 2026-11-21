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
 * What an answer does:
 * - `accepted`: done; the ledger row waits for the device's receipt.
 * - `soft_invalid`, `activity_gone`, `apns_rejected`, `invalid_item`,
 *   `activity_refused`: final for this push; nothing is deleted.
 * - `404 binding_unknown`: the device must bind again (`rebind_needed`).
 * - `410 unregistered`: Apple says the app is gone. The only answer that
 *   deletes the device row, and only below the server-side cap: more than a
 *   third of the relay devices in one hour holds every further deletion for
 *   24 hours, because that pattern is a relay or Apple defect, not a wave of
 *   uninstalls.
 * - quota, `queue_full`, `maintenance`, `apns_unavailable`, a transport
 *   failure: retried with backoff until the deadline.
 *
 * Nothing here records a channel failure: a relay or Apple outage never
 * counts against a device or a notification channel.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { relayConfig, type RelayConfig } from "@/lib/push-relay/config";
import { isCircuitOpen } from "@/lib/push-relay/circuit";
import {
  loadRegistration,
  relayCall,
  type RegistrationRow,
} from "@/lib/push-relay/registration";

export type RelayPushClass = "alert" | "silent" | "liveactivity";

export interface RelayActivity {
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
}

export interface RelaySendSummary {
  accepted: number;
  /** Items that will be retried or wait for the relay. */
  waiting: number;
  /** Items that are final without delivery. */
  failed: number;
  /** Live Activity rows whose token the relay or Apple reported gone. */
  activityGone: string[];
  /**
   * What the relay answered per item, by `ref`: only answers that carried a
   * valid relay signature get here; anything else is `transport`.
   */
  answers: RelayItemAnswer[];
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

/** Retry delays in seconds per kind of push, before jitter. */
function backoffSeconds(
  eventType: string,
  pushClass: RelayPushClass,
): number[] {
  if (pushClass === "liveactivity") return [5, 30, 120, 600];
  if (pushClass === "silent") return [30, 120, 600, 1800];
  if (eventType === "MEDICATION_INTAKE_RECORDED")
    return [5, 20, 60, 180, 480, 600];
  return [30, 120, 600, 1800, 3600];
}

/** The next attempt after `attempts` failures, jittered by 20 %. */
export function nextAttemptAt(
  eventType: string,
  pushClass: RelayPushClass,
  attempts: number,
  now: Date,
  hintSeconds: number | null = null,
): Date {
  const schedule = backoffSeconds(eventType, pushClass);
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
  if (items.length === 0) {
    return {
      accepted: 0,
      waiting: 0,
      failed: 0,
      activityGone: [],
      answers: [],
    };
  }
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
              },
            }
          : {}),
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

async function finish(
  id: string,
  status: "accepted" | "dropped" | "failed",
  reason: string | null,
) {
  await prisma.pushRelayDelivery.update({
    where: { id },
    data: {
      status,
      reason,
      item: Prisma.DbNull,
      nextAttemptAt: null,
      ...(status === "accepted" ? { acceptedAt: new Date() } : {}),
    },
  });
}

async function reschedule(row: PendingRow, now: Date, hint: number | null) {
  const at = nextAttemptAt(
    row.eventType,
    row.pushClass as RelayPushClass,
    row.attempts,
    now,
    hint,
  );
  if (at >= row.expiresAt) {
    await finish(row.id, "dropped", "deadline");
    getEvent()?.addMeta("push_relay_stale_dropped", true);
    return;
  }
  await prisma.pushRelayDelivery.update({
    where: { id: row.id },
    data: { attempts: { increment: 1 }, nextAttemptAt: at },
  });
}

/** Hold everything until the relay can take it again. */
async function holdAll(rows: PendingRow[], until: Date) {
  await prisma.pushRelayDelivery.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { nextAttemptAt: until },
  });
}

/** Try the given pending deliveries now. */
export async function attemptDeliveries(
  ids: string[],
  config: RelayConfig = relayConfig(),
): Promise<RelaySendSummary> {
  const summary: RelaySendSummary = {
    accepted: 0,
    waiting: 0,
    failed: 0,
    activityGone: [],
    answers: [],
  };
  const now = new Date();
  const registration = config.available ? await loadRegistration(config) : null;
  const pending = await loadPending(ids);
  const live: PendingRow[] = [];
  for (const row of pending) {
    if (row.expiresAt <= now) {
      await finish(row.id, "dropped", "deadline");
      getEvent()?.addMeta("push_relay_stale_dropped", true);
      summary.failed += 1;
    } else if (!row.device.apnsToken || row.device.relayState !== "bound") {
      await finish(row.id, "failed", "not_bound");
      summary.failed += 1;
    } else {
      live.push(row);
    }
  }
  if (live.length === 0) return summary;
  if (!registration?.instanceId || isCircuitOpen(registration)) {
    await holdAll(
      live,
      registration?.nextProbeAt ?? new Date(now.getTime() + 60 * SECOND),
    );
    summary.waiting += live.length;
    return summary;
  }
  if (registration.pausedUntil && registration.pausedUntil > now) {
    await holdAll(live, registration.pausedUntil);
    summary.waiting += live.length;
    return summary;
  }
  for (let i = 0; i < live.length; i += BATCH) {
    await sendBatch(registration, live.slice(i, i + BATCH), summary, config);
  }
  return summary;
}

function wireItem(row: PendingRow, now: Date) {
  const item = (row.item ?? {}) as Record<string, unknown>;
  return {
    ref: row.ref,
    token: (row.device.apnsToken as string).toLowerCase(),
    env: row.device.apnsEnvironment === "sandbox" ? "sandbox" : "production",
    class: row.pushClass,
    ttlSeconds: Math.max(
      1,
      Math.floor((row.expiresAt.getTime() - now.getTime()) / SECOND),
    ),
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
    const hint =
      result.kind === "response"
        ? (result.retryAfter ??
          (typeof result.body?.retryAfter === "number"
            ? result.body.retryAfter
            : null))
        : null;
    const defect =
      result.kind === "response" &&
      (result.status === 413 || result.status === 422);
    for (const row of rows) {
      summary.answers.push({
        ref: row.ref,
        status: result.kind === "transport" ? 0 : result.status,
        code:
          result.kind === "transport"
            ? result.reason
            : String(result.body?.error ?? "refused"),
        reason: null,
      });
      if (defect) {
        await finish(
          row.id,
          "failed",
          String(result.body?.error ?? "invalid_item"),
        );
        summary.failed += 1;
      } else {
        await reschedule(row, now, hint);
        summary.waiting += 1;
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
    typeof answer?.retryAfter === "number" ? answer.retryAfter : null;
  summary.answers.push({
    ref: row.ref,
    status,
    code,
    reason: typeof answer?.reason === "string" ? answer.reason : null,
  });
  if (status === 200 && code === "accepted") {
    await finish(row.id, "accepted", null);
    summary.accepted += 1;
    return;
  }
  if (status === 200 && code === "activity_gone") {
    summary.activityGone.push(row.ref);
  }
  if (status === 404 && code === "binding_unknown") {
    await prisma.device.update({
      where: { id: row.device.id },
      data: { relayState: "rebind_needed", relayBoundAt: null },
    });
  }
  if (status === 410 && code === "unregistered") {
    await releaseUnregistered(registration, row.device.id, now);
    summary.failed += 1;
    return;
  }
  if (status === 429 || status === 503 || status === 0) {
    await reschedule(row, now, hint);
    summary.waiting += 1;
    return;
  }
  await finish(row.id, "failed", code.slice(0, 40));
  summary.failed += 1;
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
  await prisma.device.deleteMany({ where: { id: deviceId } });
}

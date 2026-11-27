/**
 * The relay's background pass, run every minute by the worker
 * (`push-relay-maintenance`).
 *
 * 1. Registers a registration that has no instance id yet (the relay was
 *    unreachable when the operator turned it on, or forgot the instance),
 *    unless the relay wants an invite code from the operator or paused
 *    registration.
 * 2. Probes an open breaker with a signed `GET /v1/status` when it is due,
 *    and asks the same once an hour otherwise (`relay-status.ts`), so an
 *    instance the relay forgot, its notices and its own state arrive
 *    without a push.
 * 3. Retries the outbox: pending deliveries whose next attempt is due, each
 *    with its finished envelope and its own deadline.
 * 4. Moves the staged sender-key rollout one step (announce yearly, promote
 *    after 7 days as `next`, retire `previous` after 30 days).
 * 5. Reports envelope receipts to the relay, at most every 50 minutes.
 * 6. Prunes delivery rows older than 30 days.
 * 7. Sends the relay unbinds owed for erased accounts (`unbind-queue.ts`).
 * 8. Rotates the instance signing key when it is 30 days old.
 * 9. Turns a binding conflict the app has not settled in 30 minutes into
 *    `rebind_needed` (`binding.ts`, `expireRelayConflicts`).
 */
import { prisma } from "@/lib/db";
import { loadApnsConfig } from "@/lib/notifications/senders/apns";
import { relayConfig } from "@/lib/push-relay/config";
import { OPERATOR_ACTION_REASONS } from "@/lib/push-relay/invite";
import { probeDue } from "@/lib/push-relay/circuit";
import {
  ensureInstanceRegistered,
  finishRelayDisable,
  loadRegistration,
  relayCall,
} from "@/lib/push-relay/registration";
import { expireRelayConflicts } from "@/lib/push-relay/binding";
import {
  relayRoutes,
  relayUsable,
  statusCheckDue,
} from "@/lib/push-relay/relay-state";
import { attemptDeliveries } from "@/lib/push-relay/relay-send";
import {
  markReceiptsReported,
  pendingReceiptCounts,
} from "@/lib/push-relay/receipts";
import { advanceSenderKeys } from "@/lib/push-relay/sender-keys";
import { drainRelayUnbinds } from "@/lib/push-relay/unbind-queue";
import {
  instanceKeyDue,
  rotateInstanceKey,
} from "@/lib/push-relay/instance-key";

/**
 * The relay takes one receipt report per instance every 45 minutes; 55 leaves
 * headroom for clock drift and a slow minute pass.
 */
const RECEIPT_INTERVAL_MS = 55 * 60 * 1000;
const RETENTION_MS = 30 * 24 * 3600 * 1000;
const OUTBOX_BATCH = 500;

export interface RelayMaintenanceFacts {
  registered: boolean;
  probed: boolean;
  /** The hourly `GET /v1/status` was asked. */
  status_checked: boolean;
  retried: number;
  rotated: boolean;
  receipts_sent: boolean;
  pruned: number;
  unbound: number;
  /** Unbinds given up after 7 days without reaching the relay. */
  unbinds_given_up: number;
  /** Unbinds dropped unsent: no relay holds a binding of this server. */
  unbinds_moot: number;
  instance_key_rotated: boolean;
  /** Devices whose unsettled binding conflict now asks for a rebind. */
  conflicts_expired: number;
}

export async function runRelayMaintenance(
  now: Date = new Date(),
): Promise<RelayMaintenanceFacts> {
  const facts: RelayMaintenanceFacts = {
    registered: false,
    probed: false,
    status_checked: false,
    retried: 0,
    rotated: false,
    receipts_sent: false,
    pruned: 0,
    unbound: 0,
    unbinds_given_up: 0,
    unbinds_moot: 0,
    instance_key_rotated: false,
    conflicts_expired: 0,
  };
  const config = relayConfig();
  // A switch-off the relay has not confirmed yet is finished first.
  if (config.available) await finishRelayDisable(config);
  let row = config.available ? await loadRegistration(config) : null;

  // A registration the relay refused for want of an invite code waits for
  // the operator; one the relay paused waits out the pause.
  if (
    row &&
    !row.instanceId &&
    !OPERATOR_ACTION_REASONS.has(row.stateReason ?? "") &&
    !(row.pausedUntil && row.pausedUntil > now)
  ) {
    facts.registered = await ensureInstanceRegistered(row, config);
    row = await loadRegistration(config);
  }
  if (row && relayRoutes(row) && probeDue(row, now)) {
    await relayCall(row, "GET", "/v1/status", undefined, config);
    facts.probed = true;
    row = await loadRegistration(config);
  } else if (row && statusCheckDue(row, now)) {
    // Stamped before the call: an answer that never comes waits for the
    // next hour (or the breaker), not for the next minute.
    await prisma.pushRelayRegistration.update({
      where: { id: row.id },
      data: { statusCheckedAt: now },
    });
    await relayCall(row, "GET", "/v1/status", undefined, config);
    facts.status_checked = true;
    row = await loadRegistration(config);
  }

  if (row && relayUsable(row, "push", now)) {
    const due = await prisma.pushRelayDelivery.findMany({
      where: { status: "pending", nextAttemptAt: { lte: now } },
      orderBy: { nextAttemptAt: "asc" },
      select: { id: true },
      take: OUTBOX_BATCH,
    });
    if (due.length > 0) {
      await attemptDeliveries(
        due.map((d) => d.id),
        config,
      );
      facts.retried = due.length;
    }
  }

  const unbinds = await drainRelayUnbinds(now, config);
  facts.unbound = unbinds.confirmed;
  facts.unbinds_given_up = unbinds.givenUp;
  facts.unbinds_moot = unbinds.moot;

  if (row && relayUsable(row, "upkeep", now) && instanceKeyDue(row, now)) {
    facts.instance_key_rotated =
      (await rotateInstanceKey(row, config)) === "rotated";
  }

  // The staged sender-key rollout: announce, promote after 7 days, retire
  // after 30 (`sender-keys.ts`).
  if (row || loadApnsConfig()) {
    facts.rotated = (await advanceSenderKeys(now)) !== null;
  }

  if (
    row &&
    relayUsable(row, "upkeep", now) &&
    (!row.receiptsSentAt ||
      now.getTime() - row.receiptsSentAt.getTime() >= RECEIPT_INTERVAL_MS)
  ) {
    const counts = await pendingReceiptCounts(now);
    if (counts.accepted > 0) {
      const result = await relayCall(
        row,
        "POST",
        "/v1/receipts",
        { accepted: counts.accepted, confirmed: counts.confirmed },
        config,
      );
      // Any signed answer starts the interval again, so a refused report is
      // not retried every minute.
      if (result.kind === "response") {
        await prisma.pushRelayRegistration.update({
          where: { id: row.id },
          data: { receiptsSentAt: new Date() },
        });
      }
      if (result.kind === "response" && result.status === 204) {
        await markReceiptsReported(counts.ids, now);
        facts.receipts_sent = true;
      }
    }
  }

  facts.conflicts_expired = await expireRelayConflicts(now);

  const pruned = await prisma.pushRelayDelivery.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - RETENTION_MS) } },
  });
  facts.pruned = pruned.count;
  return facts;
}

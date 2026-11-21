/**
 * The relay's background pass, run every minute by the worker
 * (`push-relay-maintenance`).
 *
 * 1. Registers a registration that has no instance id yet (the relay was
 *    unreachable when the operator turned it on, or forgot the instance).
 * 2. Probes an open breaker with a signed `GET /v1/status` when it is due.
 * 3. Retries the outbox: pending deliveries whose next attempt is due, each
 *    with its finished envelope and its own deadline.
 * 4. Rotates the envelope sender key when it is 30 days old.
 * 5. Reports envelope receipts to the relay, at most every 50 minutes.
 * 6. Prunes delivery rows older than 30 days.
 */
import { prisma } from "@/lib/db";
import { loadApnsConfig } from "@/lib/notifications/senders/apns";
import { relayConfig } from "@/lib/push-relay/config";
import { isCircuitOpen, probeDue } from "@/lib/push-relay/circuit";
import {
  ensureInstanceRegistered,
  loadRegistration,
  relayCall,
} from "@/lib/push-relay/registration";
import { attemptDeliveries } from "@/lib/push-relay/relay-send";
import {
  markReceiptsReported,
  pendingReceiptCounts,
} from "@/lib/push-relay/receipts";
import { rotateSenderKey, senderKeyDue } from "@/lib/push-relay/sender-keys";

const RECEIPT_INTERVAL_MS = 50 * 60 * 1000;
const RETENTION_MS = 30 * 24 * 3600 * 1000;
const OUTBOX_BATCH = 500;

export interface RelayMaintenanceFacts {
  registered: boolean;
  probed: boolean;
  retried: number;
  rotated: boolean;
  receipts_sent: boolean;
  pruned: number;
}

export async function runRelayMaintenance(
  now: Date = new Date(),
): Promise<RelayMaintenanceFacts> {
  const facts: RelayMaintenanceFacts = {
    registered: false,
    probed: false,
    retried: 0,
    rotated: false,
    receipts_sent: false,
    pruned: 0,
  };
  const config = relayConfig();
  let row = config.available ? await loadRegistration(config) : null;

  if (row && !row.instanceId) {
    facts.registered = await ensureInstanceRegistered(row, config);
    row = await loadRegistration(config);
  }
  if (row?.instanceId && isCircuitOpen(row) && probeDue(row, now)) {
    await relayCall(row, "GET", "/v1/status", undefined, config);
    facts.probed = true;
    row = await loadRegistration(config);
  }

  if (row?.instanceId && !isCircuitOpen(row)) {
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

  const keys = await prisma.pushEnvelopeKeys.findUnique({
    where: { id: "singleton" },
    select: { senderCreatedAt: true },
  });
  if (keys && (row || loadApnsConfig()) && senderKeyDue(keys, now)) {
    facts.rotated = await rotateSenderKey({ now });
  }

  if (
    row?.instanceId &&
    !isCircuitOpen(row) &&
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
      if (result.kind === "response" && result.status === 204) {
        await markReceiptsReported(counts.ids, now);
        await prisma.pushRelayRegistration.update({
          where: { id: row.id },
          data: { receiptsSentAt: now },
        });
        facts.receipts_sent = true;
      }
    }
  }

  const pruned = await prisma.pushRelayDelivery.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - RETENTION_MS) } },
  });
  facts.pruned = pruned.count;
  return facts;
}

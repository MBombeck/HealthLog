/**
 * Relay unbinds: owed for an erased account, a revoked device, a withdrawn
 * consent or push key.
 *
 * An account's erasure (`eraseAccount`: the person's own deletion, an
 * admin's, the purge after the grace window, a managed profile's) queues one
 * unbind per device token the relay may hold for it, inside the erasure
 * transaction, before the device rows cascade away. The relay's minute pass
 * sends them (`DELETE /v1/bindings`, which answers 204 whether or not the
 * token was bound) and retries with backoff, so a relay outage never blocks
 * a deletion. A row goes once the relay answered, or after 7 days: by then
 * the device's own direct revoke has had its chance, and the relay drops a
 * binding without pushes on its own.
 *
 * Queueing is idempotent (one row per token), and so is sending.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { relayConfig, type RelayConfig } from "@/lib/push-relay/config";
import { isCircuitOpen } from "@/lib/push-relay/circuit";
import { loadRegistration, relayCall } from "@/lib/push-relay/registration";

const GIVE_UP_MS = 7 * 24 * 3600 * 1000;
const BACKOFF_S = [60, 300, 1800, 7200, 21600];
const BATCH = 200;

/** Queue an unbind for every device of `userId` the relay may hold. */
export async function queueRelayUnbindsForAccount(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<number> {
  const devices = await tx.device.findMany({
    where: {
      userId,
      apnsToken: { not: null },
      OR: [{ relayState: { not: "none" } }, { relayConsentAt: { not: null } }],
    },
    select: { apnsToken: true },
  });
  const tokens = devices
    .map((d) => d.apnsToken?.toLowerCase())
    .filter((t): t is string => Boolean(t));
  if (tokens.length === 0) return 0;
  await tx.pushRelayUnbind.createMany({
    data: tokens.map((token) => ({ token })),
    skipDuplicates: true,
  });
  return tokens.length;
}

/**
 * Queue the unbind of one device token (a revoked device, a withdrawn
 * consent or push key) and try it at once. A relay that is down leaves it
 * queued for the minute pass.
 */
export async function queueRelayUnbind(
  apnsToken: string | null,
  config: RelayConfig = relayConfig(),
): Promise<void> {
  if (!apnsToken) return;
  const token = apnsToken.toLowerCase();
  await prisma.pushRelayUnbind.createMany({
    data: [{ token }],
    skipDuplicates: true,
  });
  await drainRelayUnbinds(new Date(), config, [token]);
}

/** Send the due unbinds. Returns how many the relay confirmed. */
export async function drainRelayUnbinds(
  now: Date = new Date(),
  config: RelayConfig = relayConfig(),
  onlyTokens?: readonly string[],
): Promise<number> {
  await prisma.pushRelayUnbind.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - GIVE_UP_MS) } },
  });
  const due = await prisma.pushRelayUnbind.findMany({
    where: {
      nextAttemptAt: { lte: now },
      ...(onlyTokens ? { token: { in: [...onlyTokens] } } : {}),
    },
    orderBy: { nextAttemptAt: "asc" },
    take: BATCH,
  });
  if (due.length === 0) return 0;
  const row = config.available ? await loadRegistration(config) : null;
  if (!row) {
    // No registration: this instance holds no binding at the relay any more
    // (switching it off deleted the instance with every binding).
    await prisma.pushRelayUnbind.deleteMany({
      where: { id: { in: due.map((d) => d.id) } },
    });
    return due.length;
  }
  let confirmed = 0;
  for (const unbind of due) {
    const fresh = await loadRegistration(config);
    const result =
      fresh?.instanceId && !isCircuitOpen(fresh)
        ? await relayCall(
            fresh,
            "DELETE",
            "/v1/bindings",
            { token: unbind.token },
            config,
          )
        : null;
    if (result?.kind === "response" && result.status === 204) {
      await prisma.pushRelayUnbind.delete({ where: { id: unbind.id } });
      confirmed += 1;
      continue;
    }
    const delay = BACKOFF_S[Math.min(unbind.attempts, BACKOFF_S.length - 1)];
    await prisma.pushRelayUnbind.update({
      where: { id: unbind.id },
      data: {
        attempts: { increment: 1 },
        nextAttemptAt: new Date(now.getTime() + delay * 1000),
      },
    });
  }
  return confirmed;
}

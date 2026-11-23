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
 * Only a signed `204` confirms an unbind. While this server cannot reach the
 * relay its registration names (`PUSH_RELAY_MODE=off`, a changed
 * `PUSH_RELAY_URL`, a switch-off the relay has not confirmed, a registration
 * still pending) the rows wait, and the admin card counts them
 * (`admin-status.ts`). A row is dropped unsent only when no registration
 * that ever reached a relay is left: then no relay holds a binding of this
 * server, and the drop is counted as `moot`, never as confirmed.
 *
 * Queueing is idempotent (one row per token), and so is sending.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { queueRelayUnbindsWhere } from "@/lib/push-relay/unbind-rows";
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
  return (await queueRelayUnbindsWhere(tx, { userId })).length;
}

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

/**
 * Whether a relay may still hold a binding of this server: a registration
 * that reached a relay (it has an instance id), under any host and in any
 * state, a switch-off in flight included.
 */
async function relayMayHoldBindings(): Promise<boolean> {
  const held = await prisma.pushRelayRegistration.count({
    where: { instanceId: { not: null } },
  });
  return held > 0;
}

export interface UnbindDrainResult {
  /** Unbinds the relay answered with a signed `204`. */
  confirmed: number;
  /** Unbinds given up after 7 days without reaching the relay. */
  givenUp: number;
  /** Unbinds dropped unsent because no relay holds a binding of this server. */
  moot: number;
}

/**
 * Send the due unbinds. Returns how many the relay confirmed, how many were
 * given up after 7 days of trying (an unbind that never reached the relay,
 * counted so the run says so instead of the row simply going), and how many
 * had nothing left to unbind.
 */
export async function drainRelayUnbinds(
  now: Date = new Date(),
  config: RelayConfig = relayConfig(),
  onlyTokens?: readonly string[],
): Promise<UnbindDrainResult> {
  const { count: givenUp } = await prisma.pushRelayUnbind.deleteMany({
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
  if (due.length === 0) return { confirmed: 0, givenUp, moot: 0 };
  const row = config.available ? await loadRegistration(config) : null;
  if (!row?.instanceId && !(await relayMayHoldBindings())) {
    // No relay holds a binding of this server any more: switching it off
    // deleted the instance with every binding, or it never registered.
    await prisma.pushRelayUnbind.deleteMany({
      where: { id: { in: due.map((d) => d.id) } },
    });
    return { confirmed: 0, givenUp, moot: due.length };
  }
  let confirmed = 0;
  for (const unbind of due) {
    // Without a registration this config can use, the row waits for one.
    const fresh = row ? await loadRegistration(config) : null;
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
  return { confirmed, givenUp, moot: 0 };
}

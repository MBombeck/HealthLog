/**
 * The one way a device row is deleted: sign-out and session revoke, the
 * device DELETE routes, an install another account takes over, a duplicate
 * row of the same install, and a token Apple or the relay reports dead.
 *
 * Every one of them queues the relay unbind of a row that may hold a binding
 * in the same transaction as the delete, the way account deletion does
 * (`queueRelayUnbindsForAccount`), so a token never stays bound to this
 * instance until the relay's own idle expiry. The unbind queue outlives the
 * row; the minute pass sends what nobody drained at once and retries what the
 * relay did not take. A leaf beside the senders: it imports no relay module
 * that reads this server's APNs config.
 * `src/__tests__/device-delete-unbind-guard.test.ts` holds every deleter to
 * this module.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  mayHoldRelayBinding,
  queueRelayUnbindsWhere,
} from "@/lib/push-relay/unbind-rows";

/**
 * Delete the rows `where` selects inside `tx`, after queueing their relay
 * unbinds. Returns how many went and the queued tokens: drain them with
 * `drainQueuedUnbinds` (`signed-out-push.ts`) once the transaction committed.
 */
export async function deleteDeviceRowsIn(
  tx: Prisma.TransactionClient,
  where: Prisma.DeviceWhereInput,
): Promise<{ count: number; unbinds: string[] }> {
  const unbinds = await queueRelayUnbindsWhere(tx, where);
  const { count } = await tx.device.deleteMany({ where });
  return { count, unbinds };
}

/**
 * Delete the rows `where` selects in their own transaction. The queued
 * unbinds go out with the minute pass (`unbind-queue.ts`); a caller that must
 * send them at once (sign-out, a takeover) uses {@link deleteDeviceRowsIn}
 * and drains them itself.
 */
export async function deleteDeviceRows(
  where: Prisma.DeviceWhereInput,
): Promise<number> {
  const { count } = await prisma.$transaction((tx) =>
    deleteDeviceRowsIn(tx, where),
  );
  return count;
}

/**
 * The writes that delete one loaded device row, for a caller that commits
 * them in its own `$transaction` array (the revoke cascade): the unbind
 * first when the row may hold a binding, then the delete. Drain the returned
 * tokens once the transaction committed.
 */
export function deviceDeleteWrites(device: {
  id: string;
  apnsToken: string | null;
  relayState: string;
  relayConsentAt: Date | null;
}): { writes: unknown[]; unbinds: string[] } {
  const unbind = mayHoldRelayBinding(device)
    ? (device.apnsToken as string).toLowerCase()
    : null;
  return {
    writes: [
      ...(unbind
        ? [
            prisma.pushRelayUnbind.createMany({
              data: [{ token: unbind }],
              skipDuplicates: true,
            }),
          ]
        : []),
      prisma.device.delete({ where: { id: device.id } }),
    ],
    unbinds: unbind ? [unbind] : [],
  };
}

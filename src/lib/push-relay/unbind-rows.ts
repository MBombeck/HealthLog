/**
 * Which device rows may hold a relay binding, and the queueing of their
 * unbinds inside a caller's transaction. A leaf: it reads no relay state and
 * sends nothing, so the device-delete path (`devices/delete-devices.ts`) can
 * use it from any sender without closing an import cycle. Sending the queue
 * is `unbind-queue.ts`.
 */
import type { Prisma } from "@/generated/prisma/client";

/** Whether the relay may hold a binding for this device's token. */
export function mayHoldRelayBinding(device: {
  apnsToken: string | null;
  relayState: string;
  relayConsentAt: Date | null;
}): boolean {
  return (
    Boolean(device.apnsToken) &&
    (device.relayState !== "none" || device.relayConsentAt != null)
  );
}

/**
 * Queue the relay unbind of every device row `where` selects that may hold a
 * binding, inside the caller's transaction, before the rows go. Returns the
 * queued tokens, for a drain once the transaction committed.
 */
export async function queueRelayUnbindsWhere(
  tx: Prisma.TransactionClient,
  where: Prisma.DeviceWhereInput,
): Promise<string[]> {
  const devices = await tx.device.findMany({
    where: {
      AND: [
        where,
        {
          apnsToken: { not: null },
          OR: [
            { relayState: { not: "none" } },
            { relayConsentAt: { not: null } },
          ],
        },
      ],
    },
    select: { apnsToken: true },
  });
  const tokens = [
    ...new Set(
      devices
        .map((d) => d.apnsToken?.toLowerCase())
        .filter((t): t is string => Boolean(t)),
    ),
  ];
  if (tokens.length === 0) return [];
  await tx.pushRelayUnbind.createMany({
    data: tokens.map((token) => ({ token })),
    skipDuplicates: true,
  });
  return tokens;
}

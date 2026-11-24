/**
 * Before "delete all data" removes a record's Apple Wallet passes (v1.50):
 * withdraw them and push their devices, best effort and bounded.
 *
 * The wipe deletes the pass rows in the same request, so a device that
 * fetches after the push finds the pass gone (401) and keeps the version it
 * has; its QR link is dead either way. The push still reaches a device that
 * fetches at once, and it is the only chance there is. Nothing here may stop
 * the wipe: every failure is swallowed, and the whole step ends after ten
 * seconds whatever it reached.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";

import { pushOwedWalletUpdates } from "./push";
import { voidWalletPassesWhere } from "./void";

export const WIPE_PUSH_TIMEOUT_MS = 10_000;

export async function withdrawWalletPassesBeforeWipe(
  where: Prisma.WalletPassWhereInput,
  timeoutMs: number = WIPE_PUSH_TIMEOUT_MS,
): Promise<void> {
  const work = (async () => {
    await prisma.$transaction((tx) =>
      voidWalletPassesWhere(tx, where, "ACCOUNT_DELETION"),
    );
    const passes = await prisma.walletPass.findMany({
      where: { AND: [where, { registrations: { some: {} } }] },
      select: { id: true },
      take: 2000,
    });
    for (const pass of passes) {
      await pushOwedWalletUpdates(pass.id, { throttle: false }).catch(
        () => null,
      );
    }
  })().catch(() => {
    annotate({ meta: { wallet_wipe_withdraw: "failed" } });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        annotate({ meta: { wallet_wipe_withdraw: "timeout" } });
        resolve();
      }, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}

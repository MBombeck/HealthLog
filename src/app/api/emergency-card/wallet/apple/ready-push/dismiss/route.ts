/**
 * `POST /api/emergency-card/wallet/apple/ready-push/dismiss` — the person
 * dismissed "your emergency card is ready for Wallet" (v1.50).
 *
 * The app reports its notification's dismiss action here. The no is kept per
 * person, not per device: one report silences the push everywhere, and it is
 * never sent again, a pass made anew included (`ready-push.ts`). A tap that
 * found the pass no longer available is not a no and is not reported.
 * Idempotent. Cookie or a full-access token.
 */
import { apiHandler, requireGuardianAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async () => {
  const { actor } = await requireGuardianAuth();
  annotate({ action: { name: "emergency-card.wallet.ready_push.dismissed" } });
  if (!actor.walletReadyPushDismissed) {
    await prisma.user.update({
      where: { id: actor.id },
      data: { walletReadyPushDismissed: true },
    });
  }
  return apiSuccess({ dismissed: true });
});

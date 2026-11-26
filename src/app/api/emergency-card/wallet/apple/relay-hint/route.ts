/**
 * `POST /api/emergency-card/wallet/apple/relay-hint` — the caller says no to
 * "Wallet needs the push relay" (v1.50).
 *
 * On a server that signs passes over the relay and has not switched it on,
 * the card's Wallet action explains what is missing (`state: relay_off`).
 * This records the caller's no, so the card stops prompting; the action
 * itself stays and still explains on a tap. Kept per caller, not per record:
 * a guardian who dismissed it on their own card is not asked again on a
 * ward's. Idempotent. Cookie or a full-access token (the app dismisses its
 * own copy of the prompt through the same field).
 */
import { apiHandler, requireGuardianAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async () => {
  const { actor } = await requireGuardianAuth();
  annotate({ action: { name: "emergency-card.wallet.relay_hint.dismissed" } });
  if (!actor.walletRelayHintDismissed) {
    await prisma.user.update({
      where: { id: actor.id },
      data: { walletRelayHintDismissed: true },
    });
  }
  return apiSuccess({ dismissed: true });
});

/**
 * GET /api/auth/me/mfa
 *
 * Second-factor status for the security settings hub: whether TOTP is active,
 * how many recovery codes remain, and the registered WebAuthn security keys.
 * Plain `requireAuth()` — a cookie session or a cookie-equivalent token. This
 * read is NOT elevation-gated, and deliberately so: it returns metadata only
 * (whether TOTP is on, how many recovery codes remain, and each key's name and
 * dates) and no credential material at all — no secret, no code, no public key,
 * no credential id. The web shows the same screen to any authenticated session,
 * and `/api/auth/me` already exposes `totpConfirmedAt` over Bearer, so gating it
 * would only force a factor re-proof to render a screen and buy nothing.
 *
 * Every MUTATION on this surface stays behind `requireMfaManagementAuth`. The
 * argument-less `requireAuth()` keeps the fail-closed scope default, so a
 * narrow-scope token gains no reach here.
 *
 * Returns only metadata: no secret, no recovery-code plaintext, no public key.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { countRemainingRecoveryCodes } from "@/lib/auth/mfa/recovery-codes";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const [recoveryCodesRemaining, webauthn] = await Promise.all([
    countRemainingRecoveryCodes(user.id),
    prisma.webauthnMfaCredential.findMany({
      where: { userId: user.id },
      select: { id: true, name: true, createdAt: true, lastUsedAt: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  annotate({ action: { name: "auth.mfa.status" } });

  return apiSuccess({
    totp: { enabled: Boolean(user.totpConfirmedAt) },
    recoveryCodesRemaining,
    webauthn,
    // The security hub also drives the passkey-upgrade nudge from this one
    // status read, so it knows whether the user has already dismissed it.
    passkeyNudgeDismissed: Boolean(user.passkeyUpgradeNudgeDismissed),
  });
});

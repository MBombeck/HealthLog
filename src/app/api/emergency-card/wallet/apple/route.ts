/**
 * `/api/emergency-card/wallet/apple` — the record's emergency card in Apple
 * Wallet (v1.50).
 *
 *   GET    → the status, `{ apple }`: the same resolution as
 *            `emergencyCard.wallet.apple` on `/api/auth/me`. Cookie or a
 *            full-access token (the app).
 *   POST   → make the pass: its own `hlm_` link (the raw token sealed under
 *            the instance key, because every update draws the QR code again),
 *            the ticked items and the expiry frozen on it, and the pass row.
 *            Returns where to download it; never the token, never the URL.
 *            Cookie only, with a fresh proof of the person at the keyboard.
 *   DELETE → withdraw it: the link stops answering, the pass is stamped and
 *            from then on downloads in its withdrawn version. Cookie only.
 *
 * Auth: `requireGuardianAuth()`, the owner on their own record or the
 * guardian of a managed profile; a delegate on an adult's record is refused.
 * The printed card's link and this pass's link are separate: withdrawing one
 * leaves the other.
 */
import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";

import {
  apiHandler,
  assertRecentCookieProof,
  requireGuardianAuth,
} from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import {
  emergencyWalletAppleCreateSchema,
  normaliseFields,
} from "@/lib/emergency-card/fields";
import { cardCookieOnlyRefusal } from "@/lib/emergency-card/manage";
import { mintCardToken } from "@/lib/emergency-card/token";
import {
  isHttpsOrigin,
  resolveEmergencyWalletApple,
  walletSignerReadiness,
} from "@/lib/emergency-card/wallet-pass/availability";
import {
  buildWalletPassFiles,
  hasLiveWalletLink,
  latestWalletPass,
  signerIdentityFor,
  toWalletPassSummary,
  voidWalletPass,
  WALLET_MINT_LIMIT_PER_HOUR,
  WALLET_WINDOW_MS,
} from "@/lib/emergency-card/wallet-pass/service";
import { WALLET_DOWNLOAD_PATH } from "@/lib/emergency-card/wallet-pass/constants";
import { createWalletPass } from "@/lib/emergency-card/wallet-pass/store";
import { resolveOrigin } from "@/lib/http/origin";
import { coerceLocale } from "@/lib/i18n/config";
import { withIdempotency } from "@/lib/idempotency";
import { annotate } from "@/lib/logging/context";
import { isP2002 } from "@/lib/prisma-errors";
import { WALLET_RELAY_CONSENT_TEXT_VERSION } from "@/lib/push-relay/config";
import { checkRateLimit } from "@/lib/rate-limit";
import { destroyedDetails } from "@/lib/sharing/audit-details";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

function walletExists(): Response {
  return apiError(
    "This card already has a Wallet pass. Withdraw it for a new one.",
    409,
    { errorCode: "emergency-card.wallet.exists" },
  );
}

function noWalletPass(): Response {
  return apiError("This card has no Wallet pass", 404, {
    errorCode: "emergency-card.wallet.none",
  });
}

export const GET = apiHandler(async (request: NextRequest) => {
  const auth = await requireGuardianAuth();
  annotate({ action: { name: "emergency-card.wallet.status" } });
  const apple = await resolveEmergencyWalletApple({
    recordUserId: auth.user.id,
    allowed: true,
    origin: resolveOrigin(request),
    authMethod: auth.authMethod,
    callerIsAdmin: auth.actor.role === "ADMIN",
    relayHintDismissed: auth.actor.walletRelayHintDismissed,
  });
  return apiSuccess({ apple });
});

// Wrapped in place, so the export carries its own fresh-proof gate.
export const POST = apiHandler(
  withIdempotency(async (request: NextRequest): Promise<Response> => {
    const auth = await requireGuardianAuth();
    if (auth.authMethod !== "cookie") return cardCookieOnlyRefusal();
    const { user, actor } = auth;
    // The proof is the person at the keyboard, so it is the actor's session.
    await assertRecentCookieProof(actor, auth.session.id);
    annotate({ action: { name: "emergency-card.wallet.create" } });

    if (!(await isApiGloballyEnabled())) {
      return apiError("API is globally disabled", 403, {
        errorCode: "emergency-card.api_disabled",
      });
    }

    const rl = await checkRateLimit(
      `emergency-card:wallet-mint:${actor.id}`,
      WALLET_MINT_LIMIT_PER_HOUR,
      WALLET_WINDOW_MS,
    );
    if (!rl.allowed) {
      return apiError("Too many Wallet passes, try again later", 429, {
        errorCode: "emergency-card.rateLimited",
      });
    }

    const origin = resolveOrigin(request);
    const readiness = await walletSignerReadiness();
    const unavailable =
      readiness.reason !== "ok"
        ? readiness.reason
        : !isHttpsOrigin(origin)
          ? "no_https_origin"
          : null;
    if (
      unavailable ||
      !readiness.signer ||
      !readiness.passTypeIdentifier ||
      !readiness.teamIdentifier
    ) {
      return apiError("Apple Wallet is not available on this server", 409, {
        errorCode: "emergency-card.wallet.unavailable",
        reason: unavailable ?? "relay_not_ready",
      });
    }

    const parsed = await parseJsonBody(
      request,
      emergencyWalletAppleCreateSchema,
      { maxBytes: 4 * 1024 },
    );
    if (!parsed.ok) return parsed.error;
    if (
      readiness.signer === "RELAY" &&
      parsed.data.consentTextVersion !== WALLET_RELAY_CONSENT_TEXT_VERSION
    ) {
      return apiError("Accept the current Wallet signing notice", 422, {
        errorCode: "emergency-card.wallet.consent",
      });
    }

    if (await hasLiveWalletLink(user.id)) return walletExists();

    const fields = normaliseFields(parsed.data.fields);
    const now = new Date();
    const expiresAt =
      typeof parsed.data.expiresInDays === "number"
        ? new Date(now.getTime() + parsed.data.expiresInDays * DAY_MS)
        : null;
    const minted = mintCardToken();
    const serialNumber = randomUUID();
    const { contentHash } = await buildWalletPassFiles({
      userId: user.id,
      fields,
      locale: coerceLocale(actor.locale),
      timezone: user.timezone || DEFAULT_TIMEZONE,
      signer: signerIdentityFor(readiness.signer, readiness.passTypeIdentifier),
      passTypeIdentifier: readiness.passTypeIdentifier,
      teamIdentifier: readiness.teamIdentifier,
      serialNumber,
      rawLinkToken: minted.raw,
      origin,
      contentChangedAt: now,
      expiresAt,
      voidedAt: null,
      now,
    });

    let created;
    try {
      created = await prisma.$transaction((tx) =>
        createWalletPass(tx, {
          userId: user.id,
          createdById: actor.id,
          token: minted,
          serialNumber,
          fields,
          expiresAt,
          signer: readiness.signer!,
          passTypeIdentifier: readiness.passTypeIdentifier!,
          teamIdentifier: readiness.teamIdentifier!,
          webServiceOrigin: origin,
          contentHash,
          contentChangedAt: now,
          consentTextVersion:
            readiness.signer === "RELAY"
              ? WALLET_RELAY_CONSENT_TEXT_VERSION
              : "local",
        }),
      );
    } catch (err) {
      // A second mint racing this one lost to the one-live-link index.
      if (isP2002(err)) return walletExists();
      throw err;
    }

    await auditLog("emergency-card.wallet.create", {
      userId: user.id,
      details: {
        linkId: created.linkId,
        serialNumber,
        fields,
        expiresAt: expiresAt?.toISOString() ?? null,
        signer: readiness.signer,
      },
    });

    const pass = await latestWalletPass(user.id);
    if (!pass) throw new Error("the new wallet pass is not there");
    return apiSuccess(
      {
        pass: toWalletPassSummary(pass, now),
        downloadPath: WALLET_DOWNLOAD_PATH,
      },
      201,
    );
  }),
);

export const DELETE = apiHandler(async () => {
  const auth = await requireGuardianAuth();
  if (auth.authMethod !== "cookie") return cardCookieOnlyRefusal();
  const { user } = auth;
  annotate({ action: { name: "emergency-card.wallet.revoke" } });

  const voided = await voidWalletPass(user.id, "OWNER");
  if (!voided) return noWalletPass();
  await auditLog("emergency-card.wallet.revoke", {
    userId: user.id,
    details: {
      linkId: voided.linkId,
      serialNumber: voided.serialNumber,
      ...destroyedDetails({
        model: "WalletPass",
        id: voided.walletPassId,
        label: voided.serialNumber.slice(0, 8),
        effectiveAt: voided.createdAt,
      }),
    },
  });
  return apiSuccess({ revoked: true });
});

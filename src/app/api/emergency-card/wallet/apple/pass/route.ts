/**
 * `GET /api/emergency-card/wallet/apple/pass` — the record's Wallet pass as
 * a signed `.pkpass`, built and signed for this request (v1.50).
 *
 * The web navigates here at the top level, so Safari shows Apple's add sheet;
 * the app downloads it with its token and hands the bytes to PassKit. A
 * withdrawn pass is served in its withdrawn version (no QR code, no health
 * data), so an installed pass can be replaced by one that says it no longer
 * counts; `HL-Wallet-State` says which version this is.
 *
 * Auth: `requireGuardianAuth()`, cookie or a full-access token; a narrow
 * token is refused by the default arm. No recent proof is asked, unlike
 * making the pass: making one mints a new public link, while this serves the
 * pass that already exists, whose link and `ApplePass` token the account can
 * withdraw on the card page at any time (and a password change withdraws for
 * it). A proof here could not be given either: the web reaches this route as
 * a top-level navigation that cannot show the re-proof dialog, and the app
 * calls it with its token, which never carries one. When the signer cannot sign right now
 * the answer is 503 `emergency-card.wallet.signer_unavailable` with
 * `Retry-After`; the installed pass stays as it is.
 */
import { NextRequest, NextResponse } from "next/server";

import { apiHandler, requireGuardianAuth } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import {
  buildSignedPass,
  latestWalletPass,
  WALLET_FETCH_LIMIT_PER_HOUR,
  WALLET_WINDOW_MS,
} from "@/lib/emergency-card/wallet-pass/service";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** What a caller waits before asking again when the signer is away. */
const SIGNER_RETRY_S = 60;

export const GET = apiHandler(async (_request: NextRequest) => {
  const auth = await requireGuardianAuth();
  annotate({ action: { name: "emergency-card.wallet.fetch" } });

  const pass = await latestWalletPass(auth.user.id);
  if (!pass) {
    return apiError("This card has no Wallet pass", 404, {
      errorCode: "emergency-card.wallet.none",
    });
  }

  const rl = await checkRateLimit(
    `emergency-card:wallet-fetch:${pass.id}`,
    WALLET_FETCH_LIMIT_PER_HOUR,
    WALLET_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many downloads of this pass, try again later", 429, {
      errorCode: "emergency-card.rateLimited",
    });
  }

  const signed = await buildSignedPass(pass);
  if (!signed.ok) {
    annotate({ meta: { wallet_signer: signed.reason } });
    const response = apiError("The pass cannot be signed right now", 503, {
      errorCode: "emergency-card.wallet.signer_unavailable",
    });
    response.headers.set(
      "Retry-After",
      String(Math.max(SIGNER_RETRY_S, Math.min(signed.retryAfter, 3600))),
    );
    return response;
  }

  await prisma.walletPass.update({
    where: { id: pass.id },
    data: { lastFetchedAt: new Date() },
  });
  annotate({ meta: { wallet_state: signed.state } });
  return new NextResponse(Buffer.from(signed.bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apple.pkpass",
      "Content-Disposition":
        'attachment; filename="healthlog-emergency-card.pkpass"',
      "Cache-Control": "no-store",
      "Last-Modified": signed.contentChangedAt.toUTCString(),
      "HL-Wallet-State": signed.state,
    },
  });
});

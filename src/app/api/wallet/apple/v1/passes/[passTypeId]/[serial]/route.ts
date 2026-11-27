/**
 * `GET /api/wallet/apple/v1/passes/{passTypeId}/{serial}` — Apple Wallet
 * fetches the current version of a pass (v1.50), part of the pass web
 * service (`emergency-card/wallet-pass/web-service.ts`).
 *
 * The pass is built from the record and signed for this request, the same
 * way the owner's download is, and shares its 30 per hour. `If-Modified-
 * Since` at or after the content's last change answers 304 without signing.
 * A withdrawn pass is served in its withdrawn version (no QR code, no health
 * data), which is how an installed pass learns it no longer counts; a
 * guardian's pass whose grant is gone is withdrawn here before it is served.
 * When the pass cannot be signed right now the answer is 503 with
 * `Retry-After`, and Wallet keeps the version it has.
 *
 * Auth: `Authorization: ApplePass <authenticationToken>`; every failure is
 * the same bare 401.
 */
import { NextRequest, NextResponse } from "next/server";

import { apiHandler } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import {
  latestWalletPassById,
  signSyncedPass,
  syncWalletPassContent,
  voidWalletPassById,
  WALLET_FETCH_LIMIT_PER_HOUR,
  WALLET_WINDOW_MS,
} from "@/lib/emergency-card/wallet-pass/service";
import { walletPassState } from "@/lib/emergency-card/wallet-pass/void";
import {
  authenticateWalletPass,
  bare,
  notModifiedSince,
  WALLET_WS_RETRY_S,
  walletWebServiceGate,
} from "@/lib/emergency-card/wallet-pass/web-service";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { guardianMintRefusal } from "@/lib/sharing/guardian-minted";

export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{ passTypeId: string; serial: string }>;
};

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    annotate({ action: { name: "wallet.pass.fetch" } });
    const gated = await walletWebServiceGate(request);
    if (gated) return gated;
    const { passTypeId, serial } = await params;
    const authed = await authenticateWalletPass(request, passTypeId, serial);
    if (!authed) return bare(401);

    const rl = await checkRateLimit(
      `emergency-card:wallet-fetch:${authed.id}`,
      WALLET_FETCH_LIMIT_PER_HOUR,
      WALLET_WINDOW_MS,
    );
    if (!rl.allowed) {
      const wait = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
      return bare(429, { "Retry-After": String(wait) });
    }

    // What a live pass rests on, read again on every fetch: the owner's
    // deletion request and, for a guardian's pass, the grant.
    let pass = authed;
    if (walletPassState(pass) === "live") {
      const reason = pass.ownerPendingDeletion
        ? "ACCOUNT_DELETION"
        : pass.createdById !== pass.userId &&
            (await guardianMintRefusal(pass)) !== null
          ? "GUARDIAN_LOST"
          : null;
      if (reason) {
        await voidWalletPassById(pass.id, reason);
        const reread = await latestWalletPassById(pass.id);
        if (!reread) return bare(401);
        pass = { ...reread, ownerPendingDeletion: pass.ownerPendingDeletion };
      }
    }

    const synced = await syncWalletPassContent(pass);
    const lastModified = synced.contentChangedAt.toUTCString();
    if (
      notModifiedSince(
        request.headers.get("if-modified-since"),
        synced.contentChangedAt,
      )
    ) {
      return bare(304, { "Last-Modified": lastModified });
    }

    const signed = await signSyncedPass(pass, synced);
    if (!signed.ok) {
      annotate({ meta: { wallet_signer: signed.reason } });
      return bare(503, {
        "Retry-After": String(
          Math.max(WALLET_WS_RETRY_S, Math.min(signed.retryAfter, 3600)),
        ),
      });
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
        "Cache-Control": "no-store",
        "Last-Modified": lastModified,
      },
    });
  },
);

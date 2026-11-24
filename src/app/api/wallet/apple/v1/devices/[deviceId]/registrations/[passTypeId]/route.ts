/**
 * `GET /api/wallet/apple/v1/devices/{deviceId}/registrations/{passTypeId}`
 * — Apple Wallet asks which of the passes this device registered changed,
 * part of the pass web service
 * (`emergency-card/wallet-pass/web-service.ts`).
 *
 * `?passesUpdatedSince=` carries the tag this route gave last time (Unix
 * milliseconds; anything else reads as "never"). 200 with
 * `{ serialNumbers, lastUpdated }`, or 204 when nothing changed.
 *
 * No `Authorization`: Apple's design leaves this call without one, so the
 * device library id in the path is the credential. It is looked up by HMAC
 * only, the answer names serial numbers and nothing else, an unknown device
 * and a foreign Pass Type ID both answer 204, and the per-address limit runs
 * first.
 */
import { NextRequest, NextResponse } from "next/server";

import { apiHandler } from "@/lib/api-handler";
import {
  bare,
  isDeviceId,
  isPassTypeId,
  parseUpdatedSince,
  updatedWalletSerials,
  walletWebServiceGate,
} from "@/lib/emergency-card/wallet-pass/web-service";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{ deviceId: string; passTypeId: string }>;
};

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    annotate({ action: { name: "wallet.serials.list" } });
    const gated = await walletWebServiceGate(request);
    if (gated) return gated;
    const { deviceId, passTypeId } = await params;
    if (!isDeviceId(deviceId) || !isPassTypeId(passTypeId)) return bare(204);

    const since = parseUpdatedSince(
      request.nextUrl.searchParams.get("passesUpdatedSince"),
    );
    const updated = await updatedWalletSerials(deviceId, passTypeId, since);
    if (!updated) return bare(204);
    annotate({ meta: { wallet_serials: updated.serialNumbers.length } });
    return NextResponse.json(updated, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  },
);

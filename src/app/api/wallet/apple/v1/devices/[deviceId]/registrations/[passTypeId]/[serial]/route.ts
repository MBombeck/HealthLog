/**
 * Apple Wallet's device registration for one pass (v1.50), part of the pass
 * web service (`emergency-card/wallet-pass/web-service.ts`).
 *
 *   POST   → register the device for the pass's update pushes:
 *            `{ pushToken }`, 201 when new, 200 when it was registered
 *            already. At most ten devices per pass; the next replaces the
 *            oldest. The push token is kept sealed, the device id as an HMAC.
 *   DELETE → unregister it: 200.
 *
 * Auth: `Authorization: ApplePass <authenticationToken>` of this pass; every
 * failure is the same bare 401. A pass of an account asked to be deleted
 * takes no new devices. The per-address limit runs before any lookup.
 */
import { NextRequest } from "next/server";

import { apiHandler } from "@/lib/api-handler";
import { parseJsonBody } from "@/lib/api/body";
import {
  authenticateWalletPass,
  bare,
  isDeviceId,
  registerWalletDevice,
  unregisterWalletDevice,
  walletRegistrationSchema,
  WALLET_REGISTRATION_MAX_BYTES,
  walletWebServiceGate,
} from "@/lib/emergency-card/wallet-pass/web-service";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{ deviceId: string; passTypeId: string; serial: string }>;
};

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    annotate({ action: { name: "wallet.registration.create" } });
    const gated = await walletWebServiceGate(request);
    if (gated) return gated;
    const { deviceId, passTypeId, serial } = await params;
    if (!isDeviceId(deviceId)) return bare(401);

    const parsed = await parseJsonBody(request, walletRegistrationSchema, {
      maxBytes: WALLET_REGISTRATION_MAX_BYTES,
      status: 400,
    });
    if (!parsed.ok) return bare(parsed.error.status);

    const pass = await authenticateWalletPass(request, passTypeId, serial);
    if (!pass || pass.ownerPendingDeletion) return bare(401);

    const status = await registerWalletDevice(
      pass.id,
      deviceId,
      parsed.data.pushToken,
    );
    annotate({
      meta: { wallet_registration: status === 201 ? "new" : "known" },
    });
    return bare(status);
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    annotate({ action: { name: "wallet.registration.delete" } });
    const gated = await walletWebServiceGate(request);
    if (gated) return gated;
    const { deviceId, passTypeId, serial } = await params;
    if (!isDeviceId(deviceId)) return bare(401);
    const pass = await authenticateWalletPass(request, passTypeId, serial);
    if (!pass) return bare(401);
    await unregisterWalletDevice(pass.id, deviceId);
    return bare(200);
  },
);

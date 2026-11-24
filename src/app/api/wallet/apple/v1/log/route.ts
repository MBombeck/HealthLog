/**
 * `POST /api/wallet/apple/v1/log` — Apple Wallet's error log for the pass
 * web service (v1.50). Wallet sends it when something about a pass of this
 * server went wrong on the device.
 *
 * Nothing of it is kept or logged: the content is the device's own words
 * about a pass, and could carry anything. The wide event counts the
 * messages, so an operator sees that devices complain without reading what.
 * No credential (Apple's design); the per-address limit and a 16 KiB body
 * cap run first.
 */
import { NextRequest } from "next/server";

import { apiHandler } from "@/lib/api-handler";
import { z } from "zod";

import { parseJsonBody } from "@/lib/api/body";
import {
  bare,
  WALLET_LOG_MAX_BYTES,
  walletWebServiceGate,
} from "@/lib/emergency-card/wallet-pass/web-service";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

/** Only the count is read; whatever else Wallet sends is left alone. */
const walletLogSchema = z.object({ logs: z.array(z.unknown()).optional() });

export const POST = apiHandler(async (request: NextRequest) => {
  const gated = await walletWebServiceGate(request);
  if (gated) return gated;
  const body = await parseJsonBody(request, walletLogSchema, {
    maxBytes: WALLET_LOG_MAX_BYTES,
    status: 400,
  });
  if (!body.ok) return bare(body.error.status);
  const logs = body.data.logs;
  annotate({
    action: { name: "wallet.log.receive" },
    meta: { count: Array.isArray(logs) ? Math.min(logs.length, 1000) : 0 },
  });
  return bare(200);
});

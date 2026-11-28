/**
 * `POST /api/health-connect/pairing` — mint a one-time code that pairs an
 * Android device running HealthLog Sync.
 *
 * Cookie-only with a fresh proof, for the reason `POST
 * /api/tokens/measurements` gives: what the code turns into lives a year, so
 * minting it needs the person in front of the browser, not a credential that
 * leaked for an afternoon. The answer carries the code once; only its hash is
 * stored, and it is valid for ten minutes and one exchange.
 */
import { NextRequest } from "next/server";

import {
  apiHandler,
  assertRecentCookieProof,
  requireCookieAuth,
} from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/auth/hmac";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  PAIRING_CODE_TTL_MS,
  generatePairingCode,
  pairingLink,
  pairingServerOrigin,
} from "@/lib/health-connect/pairing";

/** Codes per user per minute; a QR code is minted by a person, not a loop. */
const MINT_RATE_LIMIT_MAX = 10;
const MINT_RATE_LIMIT_WINDOW_MS = 60 * 1000;

export const POST = apiHandler(async (request: NextRequest) => {
  const { user, session } = await requireCookieAuth();
  await assertRecentCookieProof(user, session.id);
  annotate({ action: { name: "health_connect.pairing.create" } });

  if (!(await isApiGloballyEnabled())) {
    return apiError("API is globally disabled", 403, {
      errorCode: "health-connect.pair.api_disabled",
    });
  }

  const rl = await checkRateLimit(
    `health-connect:pairing:${user.id}`,
    MINT_RATE_LIMIT_MAX,
    MINT_RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many pairing codes, try again later", 429);
  }

  const now = new Date();
  const code = generatePairingCode();
  const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS);
  // Expired and used codes of this account go with each mint, so the table
  // holds no more than the codes in flight.
  await prisma.healthConnectPairing.deleteMany({
    where: {
      userId: user.id,
      OR: [{ expiresAt: { lt: now } }, { consumedAt: { not: null } }],
    },
  });
  await prisma.healthConnectPairing.create({
    data: { userId: user.id, codeHash: hashToken(code), expiresAt },
  });

  return apiSuccess({
    code,
    expiresAt: expiresAt.toISOString(),
    link: pairingLink(pairingServerOrigin(request.url), code),
  });
});

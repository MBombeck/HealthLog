/**
 * `POST /api/health-connect/pair` — exchange a pairing code for the token an
 * Android device running HealthLog Sync holds.
 *
 * No session and no Bearer: the one-time code is the credential, and it is
 * read from the body only, never from the URL, so it cannot land in an access
 * log. The per-IP limit runs before the code is looked at. Every failure of
 * the code (unknown, expired, used) answers the same 401, so the route is no
 * oracle for which codes exist.
 *
 * What it mints is narrow by construction: `permissions` is a literal holding
 * the one scope, accepted by `POST /api/health-connect/batch` and `GET
 * /api/health-connect/state` and nothing else. The token is bound to a
 * `Device` row (`apiTokenId`), so deleting the device in Settings revokes it,
 * and pairing the same install again revokes the token it held before.
 */
import { NextRequest } from "next/server";

import { apiHandler } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/auth/hmac";
import { issueApiToken } from "@/lib/auth/issue-token";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { checkAuthSurfaceRateLimit } from "@/lib/rate-limit";
import { HEALTH_CONNECT_WRITE_SCOPE } from "@/lib/health-connect/scopes";
import {
  HC_DEVICE_BUNDLE_ID,
  HC_DEVICE_PLATFORM,
  HC_TOKEN_LIFETIME_DAYS,
  hcDeviceToken,
  revokePairedToken,
} from "@/lib/health-connect/pairing";
import { hcPairRequestSchema } from "@/lib/validations/health-connect-sync";
import packageJson from "../../../../../package.json";

/** Exchanges per IP per window. A person pairs a phone, not a fleet. */
const PAIR_RATE_LIMIT_MAX = 10;
const PAIR_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

class PairRefusal extends Error {
  constructor(
    readonly status: number,
    readonly meta: { errorCode: string },
    message: string,
  ) {
    super(message);
  }
}

export const POST = apiHandler(async (request: NextRequest) => {
  annotate({ action: { name: "health_connect.pair" } });

  const rl = await checkAuthSurfaceRateLimit(
    request,
    "health-connect:pair",
    PAIR_RATE_LIMIT_MAX,
    PAIR_RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    const response = apiError(
      "Too many pairing attempts, try again later",
      429,
    );
    response.headers.set(
      "Retry-After",
      String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))),
    );
    return response;
  }

  if (!(await isApiGloballyEnabled())) {
    return apiError("API is globally disabled", 403, {
      errorCode: "health-connect.pair.api_disabled",
    });
  }

  const parsed = await parseJsonBody(request, hcPairRequestSchema, {
    maxBytes: 4 * 1024,
    errorCode: "health-connect.pair.invalid",
  });
  if (!parsed.ok) return parsed.error;
  const { code, installId, deviceModel, appVersion } = parsed.data;

  const now = new Date();
  const deviceToken = hcDeviceToken(installId);
  let result: {
    userId: string;
    token: string;
    tokenExpiresAt: Date;
    deviceId: string;
    replaced: boolean;
  };
  try {
    result = await prisma.$transaction(async (tx) => {
      const pairing = await tx.healthConnectPairing.findUnique({
        where: { codeHash: hashToken(code) },
        select: { id: true, userId: true },
      });
      // Claimed by a conditional update, so two exchanges of one code
      // cannot both win.
      const claimed = pairing
        ? await tx.healthConnectPairing.updateMany({
            where: {
              id: pairing.id,
              consumedAt: null,
              expiresAt: { gt: now },
            },
            data: { consumedAt: now },
          })
        : { count: 0 };
      if (!pairing || claimed.count === 0) {
        throw new PairRefusal(
          401,
          { errorCode: "health-connect.pair.code_invalid" },
          "This pairing code is not valid. Show a new one in Settings.",
        );
      }
      const userId = pairing.userId;

      const existing = await tx.device.findUnique({
        where: { token: deviceToken },
        select: { id: true, userId: true, apiTokenId: true },
      });
      // An install id belongs to one account. Another account's row is left
      // alone: the app makes a new install id when it disconnects.
      if (existing && existing.userId !== userId) {
        throw new PairRefusal(
          409,
          { errorCode: "health-connect.pair.install_taken" },
          "This install is paired with another account.",
        );
      }
      if (existing) await revokePairedToken(tx, existing.apiTokenId);

      const issued = await issueApiToken(
        {
          userId,
          name: `HealthLog Sync (${deviceModel ?? "Android"})`,
          // A literal, never derived from the body.
          permissions: [HEALTH_CONNECT_WRITE_SCOPE],
          expiresInDays: HC_TOKEN_LIFETIME_DAYS,
        },
        tx,
      );

      const fields = {
        model: deviceModel ?? null,
        appVersion: appVersion ?? null,
        apiTokenId: issued.tokenId,
        lastSeen: now,
      };
      const device = existing
        ? await tx.device.update({
            where: { id: existing.id },
            data: fields,
            select: { id: true },
          })
        : await tx.device.create({
            data: {
              userId,
              platform: HC_DEVICE_PLATFORM,
              token: deviceToken,
              bundleId: HC_DEVICE_BUNDLE_ID,
              ...fields,
            },
            select: { id: true },
          });
      return {
        userId,
        token: issued.token,
        tokenExpiresAt: issued.expiresAt,
        deviceId: device.id,
        replaced: existing !== null,
      };
    });
  } catch (err) {
    if (err instanceof PairRefusal) {
      annotate({ meta: { outcome: err.meta.errorCode } });
      return apiError(err.message, err.status, err.meta);
    }
    throw err;
  }

  await auditLog("health_connect.pair", {
    userId: result.userId,
    ipAddress: getClientIp(request),
    details: { deviceId: result.deviceId, replaced: result.replaced },
  });
  annotate({ meta: { outcome: "paired", replaced: result.replaced } });

  return apiSuccess({
    token: result.token,
    tokenExpiresAt: result.tokenExpiresAt.toISOString(),
    deviceId: result.deviceId,
    server: {
      version:
        process.env.NEXT_PUBLIC_APP_VERSION?.trim() || packageJson.version,
    },
  });
});

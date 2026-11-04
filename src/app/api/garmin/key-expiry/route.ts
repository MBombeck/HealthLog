import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import {
  estimateGarminKeyExpiry,
  resolveGarminKeyExpiry,
} from "@/lib/garmin/key-expiry";
import { garminKeyExpirySchema } from "@/lib/validations/garmin";
import { dateOnlyAtNoonUtc } from "@/lib/tz/date-only";

/**
 * Correct when the stored Garmin key expires, without pasting it again.
 *
 * Garmin does not report a key's end, so the card counts it from the
 * validity picked when the key was created. A wrong pick, or a key created
 * some days before it was connected here, is set right through this route:
 * the validity counts from `createdOn` when given, else from the day the key
 * was connected. `validityDays: null` forgets the estimate. Nothing is sent
 * to Garmin. Rate-limited 20/60 s per user.
 */
export const PATCH = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "garmin.key_expiry.update" } });

  const rl = await checkRateLimit(`garmin-key-expiry:${user.id}`, 20, 60_000);
  if (!rl.allowed) {
    return apiError("Too many requests", 429, {
      headers: rateLimitHeaders(rl),
    });
  }

  const parsed = await parseJsonBody(request, garminKeyExpirySchema, {
    maxBytes: 4 * 1024,
  });
  if (!parsed.ok) return parsed.error;
  const { validityDays, createdOn } = parsed.data;

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { garminApiKeyEncrypted: true, garminConnectedAt: true },
  });
  if (!dbUser?.garminApiKeyEncrypted) {
    return apiError("No Garmin connection", 404);
  }

  const from = createdOn
    ? dateOnlyAtNoonUtc(createdOn)
    : (dbUser.garminConnectedAt ?? new Date());
  const keyExpiresAt = validityDays
    ? estimateGarminKeyExpiry(from, validityDays)
    : null;

  await prisma.user.update({
    where: { id: user.id },
    data: { garminKeyExpiresAt: keyExpiresAt },
  });

  return apiSuccess({ keyExpiry: resolveGarminKeyExpiry(keyExpiresAt) });
});

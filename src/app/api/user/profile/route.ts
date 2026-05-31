/**
 * iOS-friendly user profile endpoint.
 *
 * GET   → flattened profile fields (camelCase) for the native client.
 *         Aliased over the same data exposed by `/api/auth/me`.
 * PATCH → delegates to the shared `applyProfileUpdate` helper used by
 *         `/api/auth/profile` PUT — same validation, same audit log.
 */
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { applyProfileUpdate } from "@/lib/auth/profile-update";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "user.profile.get" } });

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      username: true,
      displayName: true,
      email: true,
      dateOfBirth: true,
      gender: true,
      heightCm: true,
      locale: true,
      timezone: true,
      moodReminderEnabled: true,
      fullName: true,
      insurerName: true,
      insuranceNumberEncrypted: true,
    },
  });

  // v1.7.0 — decrypt the KVNR fail-soft so a key-rotation gap never 500s
  // the profile fetch.
  let insuranceNumber: string | null = null;
  if (dbUser?.insuranceNumberEncrypted) {
    try {
      insuranceNumber = decrypt(dbUser.insuranceNumberEncrypted);
    } catch {
      insuranceNumber = null;
    }
  }

  return apiSuccess({
    username: dbUser?.username ?? user.username,
    displayName: dbUser?.displayName ?? null,
    email: dbUser?.email ?? null,
    dateOfBirth: dbUser?.dateOfBirth?.toISOString() ?? null,
    gender: dbUser?.gender ?? null,
    heightCm: dbUser?.heightCm ?? null,
    locale: dbUser?.locale ?? null,
    timezone: dbUser?.timezone ?? "Europe/Berlin",
    moodReminderEnabled: dbUser?.moodReminderEnabled ?? false,
    fullName: dbUser?.fullName ?? null,
    insurerName: dbUser?.insurerName ?? null,
    insuranceNumber,
  });
});

export const PATCH = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error } = await safeJson(request);
  if (error) return error;

  const result = await applyProfileUpdate(user.id, body, getClientIp(request));
  if (!result.ok) {
    return apiError(result.message, result.status);
  }

  annotate({ action: { name: "user.profile.update" } });

  return apiSuccess({
    username: result.user.username,
    displayName: result.user.displayName,
    email: result.user.email,
    dateOfBirth: result.user.dateOfBirth?.toISOString() ?? null,
    gender: result.user.gender,
    heightCm: result.user.heightCm,
    locale: result.user.locale,
    timezone: result.user.timezone,
    moodReminderEnabled: result.user.moodReminderEnabled,
    fullName: result.user.fullName,
    insurerName: result.user.insurerName,
    hasInsuranceNumber: result.user.hasInsuranceNumber,
  });
});

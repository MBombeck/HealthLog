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
  apiValidationError,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { applyProfileUpdate } from "@/lib/auth/profile-update";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { resolveModuleMap } from "@/lib/modules/gate";
import { resolveStoredTimezone } from "@/lib/tz/resolver";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "user.profile.get" } });

  // Overlap the profile-row read with the module-map resolve (a separate
  // memoised Postgres round-trip) — both feed the same response and have
  // no ordering dependency.
  const [dbUser, modules] = await Promise.all([
    prisma.user.findUnique({
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
        timeFormat: true,
        dateFormat: true,
        moodReminderEnabled: true,
        fullName: true,
        insurerName: true,
        insurerIkNumber: true,
        insuranceNumberEncrypted: true,
      },
    }),
    // v1.18.0 — resolved module enable/disable map, identical to the
    // projection `GET /api/auth/me` returns. The iOS app reads this alias
    // endpoint, so it must carry the same server-authoritative flags; a
    // `false` key means the module surface disappears end-to-end.
    resolveModuleMap(user.id),
  ]);

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
    // The zone the server cuts this account's days in, exactly as
    // `/api/auth/me` reports it: the stored zone, or the instance default
    // when the stored value is unusable. Never the raw column.
    timezone: await resolveStoredTimezone(dbUser?.timezone),
    timeFormat: dbUser?.timeFormat ?? "AUTO",
    dateFormat: dbUser?.dateFormat ?? "AUTO",
    moodReminderEnabled: dbUser?.moodReminderEnabled ?? false,
    fullName: dbUser?.fullName ?? null,
    insurerName: dbUser?.insurerName ?? null,
    insurerIkNumber: dbUser?.insurerIkNumber ?? null,
    insuranceNumber,
    // v1.18.0 — module enable/disable map, matching the /api/auth/me
    // projection exactly so the native client gets module flags from the
    // endpoint it actually reads.
    modules,
  });
});

export const PATCH = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (error) return error;

  const result = await applyProfileUpdate(user.id, body, getClientIp(request));
  if (!result.ok) {
    const meta = result.errorCode ? { errorCode: result.errorCode } : undefined;
    return result.issues
      ? apiValidationError(result.message, result.issues, result.status, meta)
      : apiError(result.message, result.status, meta);
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
    timezone: await resolveStoredTimezone(result.user.timezone),
    timeFormat: result.user.timeFormat,
    dateFormat: result.user.dateFormat,
    moodReminderEnabled: result.user.moodReminderEnabled,
    fullName: result.user.fullName,
    insurerName: result.user.insurerName,
    insurerIkNumber: result.user.insurerIkNumber,
    hasInsuranceNumber: result.user.hasInsuranceNumber,
    ...(result.rejectedFields ? { rejectedFields: result.rejectedFields } : {}),
  });
});

import { NextRequest } from "next/server";

import {
  apiHandler,
  MFA_STEP_UP_MAX_AGE_SECONDS,
  requireFreshMfa,
} from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { createManagedProfile } from "@/lib/managed-profiles/create";
import { toManagedProfileView } from "@/lib/managed-profiles/lifecycle";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { createManagedProfileSchema } from "@/lib/validations/managed-profiles";

/**
 * The same ceiling its guardian sibling carries, and for the same reason.
 *
 * `POST /api/managed-profiles/{id}/guardians` has been rate-limited at ten an
 * hour since it shipped; this route creates a real account row on every call
 * and had none. A person cannot mistype their way into a hundred accounts, but
 * a script can, and the two endpoints of one family answering differently to
 * the same abuse is the kind of asymmetry nobody notices until it is used.
 */
const CREATE_LIMIT = 10;
const CREATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Create a record a Guardian administers. This deliberately uses the
 * cookie-only fresh-MFA gate: a Bearer token cannot mint a credential-less
 * person and persistent management relationship.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireFreshMfa(MFA_STEP_UP_MAX_AGE_SECONDS);
  // Before the body is read, exactly as the guardian route does it: the cheap
  // refusal comes first so a flood costs a bucket lookup rather than a parse.
  const rateLimit = await checkRateLimit(
    `managed-profile:create:${user.id}`,
    CREATE_LIMIT,
    CREATE_WINDOW_MS,
  );
  if (!rateLimit.allowed) {
    return apiError("Too many profiles created, try again later", 429);
  }
  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = createManagedProfileSchema.safeParse(body);
  if (!parsed.success) return returnAllZodIssues(parsed.error, 422);

  const { profile, creatorGrant } = await createManagedProfile({
    creatorId: user.id,
    displayName: parsed.data.displayName,
    dateOfBirth: parsed.data.dateOfBirth
      ? new Date(`${parsed.data.dateOfBirth}T00:00:00.000Z`)
      : null,
    locale: parsed.data.locale,
    timezone: parsed.data.timezone,
    // Absent and null both mean "not recorded". The record keeps the same
    // NULL an account that never answered carries, and the cycle module
    // derives its default from it rather than from a guess about the person.
    gender: parsed.data.gender ?? null,
  });

  await auditLog("managed_profile.created", {
    userId: user.id,
    details: { profileId: profile.id, grantId: creatorGrant.id },
  }).catch(() => {});
  annotate({
    action: { name: "managed_profile.create" },
    meta: { profile_id: profile.id },
  });

  return apiSuccess(toManagedProfileView(profile), 201);
});

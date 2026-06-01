import {
  apiSuccess,
  apiError,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { applyProfileUpdate } from "@/lib/auth/profile-update";

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson(request);
  if (jsonError) return jsonError;

  const result = await applyProfileUpdate(user.id, body, getClientIp(request));
  if (!result.ok) {
    return apiError(result.message, result.status);
  }

  annotate({ action: { name: "auth.profile.update" } });

  return apiSuccess({
    id: result.user.id,
    username: result.user.username,
    email: result.user.email,
    role: result.user.role,
    heightCm: result.user.heightCm,
    dateOfBirth: result.user.dateOfBirth,
    gender: result.user.gender,
    timezone: result.user.timezone,
    fullName: result.user.fullName,
    insurerName: result.user.insurerName,
    hasInsuranceNumber: result.user.hasInsuranceNumber,
  });
});

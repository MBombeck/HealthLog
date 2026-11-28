import {
  apiSuccess,
  apiError,
  apiValidationError,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { NextRequest } from "next/server";
import { apiHandler, requireSelfAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { applyProfileUpdate } from "@/lib/auth/profile-update";
import { authorizeSensitiveChange } from "@/lib/auth/existing-factor-proof";
import { enqueueWalletRefresh } from "@/lib/emergency-card/wallet-pass/queues";

export const PUT = apiHandler(async (request: NextRequest) => {
  const auth = await requireSelfAuth();
  const { user } = auth;

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const ip = getClientIp(request);
  const result = await applyProfileUpdate(user.id, body, ip, {
    // A new email address needs a fresh proof: the address is what single
    // sign-on links an existing account by.
    authorizeEmailChange: (currentPassword) =>
      authorizeSensitiveChange({
        user,
        cookieSessionId: auth.authMethod === "cookie" ? auth.session.id : null,
        currentPassword,
        ipAddress: ip,
        stage: "email_change",
      }),
  });
  if (!result.ok) {
    const meta = result.errorCode ? { errorCode: result.errorCode } : undefined;
    return result.issues
      ? apiValidationError(result.message, result.issues, result.status, meta)
      : apiError(result.message, result.status, meta);
  }

  annotate({ action: { name: "auth.profile.update" } });

  await enqueueWalletRefresh(user.id);
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
    insurerIkNumber: result.user.insurerIkNumber,
    hasInsuranceNumber: result.user.hasInsuranceNumber,
    insuranceNumberCountry: result.user.insuranceNumberCountry,
    insuranceGroupNumber: result.user.insuranceGroupNumber,
    ...(result.rejectedFields ? { rejectedFields: result.rejectedFields } : {}),
  });
});

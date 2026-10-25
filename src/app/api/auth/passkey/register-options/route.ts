import { NextRequest } from "next/server";
import {
  createAuthenticationOptions,
  createRegistrationOptions,
} from "@/lib/auth/passkey";
import { createMfaAuthenticationOptions } from "@/lib/auth/mfa/webauthn";
import {
  isSecondFactorProof,
  recordReproofFailure,
  refundReproof,
  throttleReproof,
  verifyExistingFactorProof,
} from "@/lib/auth/existing-factor-proof";
import {
  hasSecondFactorEnrolled,
  recentProofMethods,
} from "@/lib/auth/second-factor";
import { prisma } from "@/lib/db";
import {
  apiError,
  apiSuccess,
  getClientIp,
  safeJson,
  isJsonContentType,
} from "@/lib/api-response";
import { apiHandler, requireCookieAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { stepUpMintSchema } from "@/lib/validations/step-up";

const proofRequired = () =>
  apiError("Fresh existing-factor proof required", 401);

export const POST = apiHandler(async (request: NextRequest) => {
  const { user, session } = await requireCookieAuth();

  if (!isJsonContentType(request.headers.get("content-type"))) {
    return proofRequired();
  }

  const { data: body, error: jsonError } = await safeJson<
    Record<string, unknown>
  >(request, { maxBytes: 64 * 1024 });
  if (jsonError) return proofRequired();

  // Begin an assertion ceremony without beginning registration. This lets the
  // browser re-prove a passkey or second-factor security key before this route
  // creates any enrollment challenge.
  if (
    Object.keys(body).length === 1 &&
    (body.method === "passkey" || body.method === "webauthn")
  ) {
    const result =
      body.method === "passkey"
        ? await createAuthenticationOptions(user.id)
        : await createMfaAuthenticationOptions(user.id);
    if (!result) {
      return apiError("That verification method is unavailable", 409);
    }
    return apiSuccess({ ...result, reauth: true });
  }

  const parsed = stepUpMintSchema.safeParse(body);
  if (!parsed.success) return proofRequired();

  // On an account with a second factor a password does not add a sign-in
  // credential, exactly as it does not satisfy the second factor at sign-in:
  // a passkey registered on the strength of the password alone would from then
  // on sign in without the second factor at all. Refused before a guess is
  // spent, with the proofs that would work.
  if (
    !isSecondFactorProof(parsed.data.method) &&
    (await hasSecondFactorEnrolled(user))
  ) {
    annotate({
      action: { name: "auth.reproof.method_refused" },
      meta: { stage: "passkey_enroll", method: parsed.data.method },
    });
    return apiError("Confirm with your second factor or a passkey", 422, {
      errorCode: "auth.reproof.too_weak",
      methods: await recentProofMethods(user, true),
    });
  }

  // Every proof counts against the account's shared re-proof bucket and every
  // refusal is audited. Without both, a stolen session could guess the account
  // password or a TOTP code here as fast as it could send requests.
  const ip = getClientIp(request);
  const limited = await throttleReproof(user.id, ip, "passkey_enroll");
  if (limited) return limited;

  const outcome = await verifyExistingFactorProof(user, parsed.data);
  if (!outcome.ok) {
    await recordReproofFailure(
      user.id,
      ip,
      "passkey_enroll",
      parsed.data.method,
      outcome.reason,
    );
    return proofRequired();
  }
  await refundReproof(user.id);

  // A strong existing factor refreshes the session's MFA stamp. Password proof
  // deliberately clears it: registration is authorized by this single-use,
  // session-bound challenge but cannot upgrade password-only authentication.
  await prisma.session.update({
    where: { id: session.id },
    data: {
      mfaVerifiedAt: parsed.data.method === "password" ? null : new Date(),
    },
  });

  const { options, challengeId } = await createRegistrationOptions(
    user.id,
    user.email ?? user.username,
    session.id,
  );

  annotate({ action: { name: "auth.passkey.register-options" } });

  return apiSuccess({ options, challengeId });
});

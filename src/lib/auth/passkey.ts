import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from "@simplewebauthn/server";
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import {
  RP_NAME as rpName,
  getRpId,
  getExpectedOrigin,
  REGISTRATION_ACCEPTED_ALGORITHM_IDS,
  REGISTRATION_OFFERED_ALGORITHM_IDS,
} from "@/lib/auth/webauthn-rp";
import { hashToken } from "@/lib/auth/hmac";

// v1.4.43 W13 L-3 — explicit Zod narrowing in front of
// `verifyAuthentication`. Replaces the raw
// `as AuthenticationResponseJSON` cast; the SimpleWebAuthn verifier
// still owns the cryptographic validation downstream, but a
// malformed body now fails fast at the boundary with a structured
// error rather than crashing on a follow-up `.id` deref.
//
// Shape mirrors SimpleWebAuthn's `AuthenticationResponseJSON`:
//   https://w3c.github.io/webauthn/#dictdef-authenticationresponsejson
// The schema is intentionally permissive (`passthrough` + optionals)
// so future authenticator-attachment / extension-result additions
// don't break the boundary; the strict checks remain inside
// `verifyAuthenticationResponse`.
const authenticationResponseSchema = z
  .object({
    id: z.string().min(1),
    rawId: z.string().min(1),
    response: z
      .object({
        clientDataJSON: z.string().min(1),
        authenticatorData: z.string().min(1),
        signature: z.string().min(1),
        userHandle: z.string().optional(),
      })
      .loose(),
    authenticatorAttachment: z.string().optional(),
    clientExtensionResults: z.unknown().optional(),
    type: z.literal("public-key"),
  })
  .loose();

// v1.4.43 W10 senior-dev L-1 — symmetric Zod narrowing in front of
// `verifyRegistration`. SimpleWebAuthn's `RegistrationResponseJSON`
// shape: https://w3c.github.io/webauthn/#dictdef-registrationresponsejson
// `attestationObject` replaces `authenticatorData + signature` from
// the authentication shape; everything else mirrors the auth schema.
const registrationResponseSchema = z
  .object({
    id: z.string().min(1),
    rawId: z.string().min(1),
    response: z
      .object({
        clientDataJSON: z.string().min(1),
        attestationObject: z.string().min(1),
        transports: z.array(z.string()).optional(),
        publicKeyAlgorithm: z.number().optional(),
        publicKey: z.string().optional(),
        authenticatorData: z.string().optional(),
      })
      .loose(),
    authenticatorAttachment: z.string().optional(),
    clientExtensionResults: z.unknown().optional(),
    type: z.literal("public-key"),
  })
  .loose();

type Transport =
  "ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb";

const PASSKEY_REGISTRATION_CHALLENGE_PREFIX = "passkey-registration:v1:";

function registrationChallengeType(sessionId: string): string {
  return `${PASSKEY_REGISTRATION_CHALLENGE_PREFIX}${hashToken(sessionId)}`;
}

// The relying-party config (`rpName` / `getRpId` / `getExpectedOrigin`) is
// shared with the second-factor security-key path via `@/lib/auth/webauthn-rp`
// so both ceremonies bind credentials to the identical RP.

async function cleanupExpiredChallenges() {
  await prisma.authChallenge.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
}

// ── Registration ─────────────────────────────────────────

export async function createRegistrationOptions(
  userId: string,
  username: string,
  sessionId: string,
) {
  await cleanupExpiredChallenges();

  const existingPasskeys = await prisma.passkey.findMany({
    where: { userId },
    select: { credentialId: true, transports: true },
  });

  const options = await generateRegistrationOptions({
    rpName,
    rpID: getRpId(),
    userName: username,
    attestationType: "none",
    supportedAlgorithmIDs: REGISTRATION_OFFERED_ALGORITHM_IDS,
    excludeCredentials: existingPasskeys.map((pk) => ({
      id: pk.credentialId,
      transports: pk.transports as Transport[],
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      // `required` (vs `preferred`) instructs the authenticator that
      // a UV check (biometric / PIN / fingerprint) is mandatory for
      // every registration ceremony. A `preferred` posture lets a
      // device that lacks a UV factor silently downgrade — and the
      // resulting passkey carries the same `userVerified: false` flag
      // forever, blocking any future AAL3-style assertion against it.
      userVerification: "required",
    },
  });

  // Store challenge with 5-min TTL
  const challenge = await prisma.authChallenge.create({
    data: {
      userId,
      challenge: options.challenge,
      type: registrationChallengeType(sessionId),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    },
  });

  return { options, challengeId: challenge.id };
}

export type RegistrationChallengeClaim =
  | { ok: true; expectedChallenge: string; createdAt: Date }
  | { ok: false; reason: "invalid" | "wrong_context" };

/**
 * Claim a registration challenge for exactly one cookie session.
 *
 * The preliminary lookup is used only to classify a foreign account/session
 * without consuming its challenge. The guarded DELETE is the actual claim:
 * concurrent requests cannot both receive the challenge material.
 */
export async function consumeRegistrationChallenge(input: {
  challengeId: string;
  userId: string;
  sessionId: string;
}): Promise<RegistrationChallengeClaim> {
  const row = await prisma.authChallenge.findUnique({
    where: { id: input.challengeId },
    select: { userId: true, type: true, expiresAt: true },
  });

  if (!row) return { ok: false, reason: "invalid" };

  const expectedType = registrationChallengeType(input.sessionId);
  if (
    row.userId !== input.userId ||
    (row.type.startsWith(PASSKEY_REGISTRATION_CHALLENGE_PREFIX) &&
      row.type !== expectedType)
  ) {
    return { ok: false, reason: "wrong_context" };
  }

  if (row.type !== expectedType || row.expiresAt <= new Date()) {
    return { ok: false, reason: "invalid" };
  }

  const claimed = await prisma.$queryRaw<
    Array<{ challenge: string; created_at: Date }>
  >`
    DELETE FROM auth_challenges
    WHERE id = ${input.challengeId}
      AND user_id = ${input.userId}
      AND type = ${expectedType}
      AND expires_at > NOW()
    RETURNING challenge, created_at
  `;

  if (claimed.length !== 1) {
    return { ok: false, reason: "invalid" };
  }

  return {
    ok: true,
    expectedChallenge: claimed[0].challenge,
    createdAt: claimed[0].created_at,
  };
}

export async function verifyRegistration(
  expectedChallenge: string,
  response: unknown,
): Promise<VerifiedRegistrationResponse> {
  // v1.4.43 W10 senior-dev L-1 — Zod narrow at the boundary before
  // delegating to SimpleWebAuthn's full cryptographic validation.
  // A malformed body now fails fast with a structured Zod error
  // rather than crashing on a follow-up `.id` deref deeper in the
  // verifier. Mirrors the v1.4.43 W13 L-3 narrowing on the
  // authentication side.
  const parsed = registrationResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new Error("Registration response shape invalid");
  }
  return verifyRegistrationResponse({
    response: parsed.data as RegistrationResponseJSON,
    expectedChallenge,
    expectedOrigin: getExpectedOrigin(),
    expectedRPID: getRpId(),
    supportedAlgorithmIDs: REGISTRATION_ACCEPTED_ALGORITHM_IDS,
  });
}

// ── Authentication ───────────────────────────────────────

export async function createAuthenticationOptions(userId?: string) {
  await cleanupExpiredChallenges();

  let allowCredentials: { id: string; transports?: Transport[] }[] | undefined;

  if (userId) {
    const passkeys = await prisma.passkey.findMany({
      where: { userId },
      select: { credentialId: true, transports: true },
    });
    allowCredentials = passkeys.map((pk) => ({
      id: pk.credentialId,
      transports: pk.transports as Transport[],
    }));
  }

  const options = await generateAuthenticationOptions({
    rpID: getRpId(),
    // Match the registration posture — see `createRegistrationOptions`
    // above for the rationale. Refusing to honour a `userVerified:
    // false` assertion keeps the AAL3 floor that the registration
    // policy now enforces.
    userVerification: "required",
    allowCredentials,
  });

  const challenge = await prisma.authChallenge.create({
    data: {
      userId: userId ?? null,
      challenge: options.challenge,
      type: "authentication",
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    },
  });

  return { options, challengeId: challenge.id };
}

export async function verifyAuthentication(
  challengeId: string,
  response: unknown,
): Promise<{
  verification: VerifiedAuthenticationResponse;
  passkey: { userId: string };
}> {
  const challenge = await prisma.authChallenge.findUnique({
    where: { id: challengeId },
  });

  if (!challenge || challenge.expiresAt < new Date()) {
    throw new Error("Challenge expired or not found");
  }

  // v1.4.43 W13 L-3 — explicit Zod narrowing instead of the previous
  // raw `as AuthenticationResponseJSON` cast. A malformed body now
  // throws here with a structured error rather than crashing on a
  // follow-up `.id` deref. The SimpleWebAuthn verifier downstream
  // still owns cryptographic validation; this just closes the
  // type-narrowing gap a future refactor could trip on.
  const parsed = authenticationResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new Error("Malformed passkey authentication response");
  }
  const typedResponse = parsed.data as unknown as AuthenticationResponseJSON;

  // Find the passkey by credential ID
  const credentialId = typedResponse.id;
  const passkey = await prisma.passkey.findUnique({
    where: { credentialId },
  });

  if (!passkey) {
    throw new Error("Passkey not found");
  }

  try {
    const verification = await verifyAuthenticationResponse({
      response: typedResponse,
      expectedChallenge: challenge.challenge,
      expectedOrigin: getExpectedOrigin(),
      expectedRPID: getRpId(),
      credential: {
        id: passkey.credentialId,
        publicKey: passkey.credentialPublicKey,
        counter: Number(passkey.counter),
        transports: passkey.transports as Transport[],
      },
    });

    if (verification.verified) {
      // Update counter + stamp last-used so the management UI can surface
      // when each passkey was last exercised (v1.23 passkey QoL).
      await prisma.passkey.update({
        where: { id: passkey.id },
        data: {
          counter: BigInt(verification.authenticationInfo.newCounter),
          lastUsedAt: new Date(),
        },
      });
    }

    return { verification, passkey: { userId: passkey.userId } };
  } finally {
    // Invalidate challenge after first verification attempt (success or failure)
    await prisma.authChallenge
      .delete({ where: { id: challengeId } })
      .catch(() => {});
  }
}

/**
 * WebAuthn as a **second factor** — distinct from the passwordless-primary
 * passkey path in `src/lib/auth/passkey.ts`.
 *
 * Differences from the primary path (see `.planning` design §3.2):
 * - Credentials live in `WebauthnMfaCredential`, NOT `Passkey`. A `Passkey`
 *   row is itself a login credential; an MFA credential is meaningless without
 *   the password, so conflating the two would silently turn a security-key
 *   registration into a passwordless login credential.
 * - Registration uses `residentKey: "discouraged"` (non-resident → does not
 *   consume a discoverable-credential slot, so an account can register many
 *   keys) and `userVerification: "preferred"` (the password already supplied
 *   one factor; a roaming key need not always carry a PIN/biometric).
 * - The login ceremony scopes `allowCredentials` to the **already
 *   password-identified** user's MFA keys — never an empty allow-list, because
 *   a non-resident credential is not discoverable.
 *
 * The transient challenge rides the shared `AuthChallenge` store under
 * dedicated `mfa_registration` / `mfa_authentication` types so it never
 * collides with the primary-passkey challenges.
 */
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

// Boundary narrowing mirrors `passkey.ts`: a malformed body fails fast with a
// structured error here, while SimpleWebAuthn still owns the cryptographic
// validation downstream.
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

type Transport =
  "ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

async function cleanupExpiredChallenges() {
  await prisma.authChallenge.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
}

// ── Registration (settings, cookie-authenticated) ────────────────────

export async function createMfaRegistrationOptions(
  userId: string,
  username: string,
) {
  await cleanupExpiredChallenges();

  const existing = await prisma.webauthnMfaCredential.findMany({
    where: { userId },
    select: { credentialId: true, transports: true },
  });

  const options = await generateRegistrationOptions({
    rpName,
    rpID: getRpId(),
    userName: username,
    attestationType: "none",
    supportedAlgorithmIDs: REGISTRATION_OFFERED_ALGORITHM_IDS,
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: c.transports as Transport[],
    })),
    authenticatorSelection: {
      // Non-resident: the password already identifies the account, so the
      // credential need not be discoverable — and a non-resident key does not
      // burn a discoverable-credential slot, allowing many keys per account.
      residentKey: "discouraged",
      // The server verify enforces user verification (SimpleWebAuthn's default
      // `requireUserVerification: true`), so the browser ceremony must ask for
      // it too — a key that passes the browser but skips UV would otherwise
      // fail server-side. Make the intent explicit rather than relying on the
      // ceremony defaulting to a stricter posture.
      userVerification: "required",
      authenticatorAttachment: "cross-platform",
    },
  });

  const challenge = await prisma.authChallenge.create({
    data: {
      userId,
      challenge: options.challenge,
      type: "mfa_registration",
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    },
  });

  return { options, challengeId: challenge.id };
}

export async function verifyMfaRegistration(
  challengeId: string,
  userId: string,
  response: unknown,
): Promise<VerifiedRegistrationResponse> {
  const challenge = await prisma.authChallenge.findUnique({
    where: { id: challengeId },
  });

  // The challenge must be live, of the registration type, and bound to the
  // calling user — a challenge minted for another account can never be reused.
  if (
    !challenge ||
    challenge.expiresAt < new Date() ||
    challenge.type !== "mfa_registration" ||
    challenge.userId !== userId
  ) {
    throw new Error("Challenge expired or not found");
  }

  try {
    const parsed = registrationResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw new Error("Registration response shape invalid");
    }
    return await verifyRegistrationResponse({
      response: parsed.data as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: getExpectedOrigin(),
      expectedRPID: getRpId(),
      supportedAlgorithmIDs: REGISTRATION_ACCEPTED_ALGORITHM_IDS,
    });
  } finally {
    await prisma.authChallenge
      .delete({ where: { id: challengeId } })
      .catch(() => {});
  }
}

// ── Authentication (mid-login second factor) ─────────────────────────

/**
 * Generate an assertion challenge scoped to a single user's MFA credentials.
 * The caller has already password-identified the account (via the MFA ticket),
 * so `allowCredentials` is always populated — a non-resident credential is not
 * discoverable from an empty allow-list. Returns null when the user has no
 * security keys registered (the caller should fall back to another factor).
 */
export async function createMfaAuthenticationOptions(userId: string) {
  await cleanupExpiredChallenges();

  const credentials = await prisma.webauthnMfaCredential.findMany({
    where: { userId },
    select: { credentialId: true, transports: true },
  });

  if (credentials.length === 0) return null;

  const options = await generateAuthenticationOptions({
    rpID: getRpId(),
    // Match server-side enforcement: the verify step requires user
    // verification (SimpleWebAuthn default), so the browser must request it too.
    userVerification: "required",
    allowCredentials: credentials.map((c) => ({
      id: c.credentialId,
      transports: c.transports as Transport[],
    })),
  });

  const challenge = await prisma.authChallenge.create({
    data: {
      userId,
      challenge: options.challenge,
      type: "mfa_authentication",
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    },
  });

  return { options, challengeId: challenge.id };
}

/**
 * Verify a mid-login security-key assertion against the user's MFA credentials.
 * Returns true on a verified assertion (counter + last-used are stamped); the
 * caller then claims the MFA ticket and finishes the login.
 */
export async function verifyMfaAuthentication(
  challengeId: string,
  userId: string,
  response: unknown,
): Promise<boolean> {
  const challenge = await prisma.authChallenge.findUnique({
    where: { id: challengeId },
  });

  if (
    !challenge ||
    challenge.expiresAt < new Date() ||
    challenge.type !== "mfa_authentication" ||
    challenge.userId !== userId
  ) {
    throw new Error("Challenge expired or not found");
  }

  const parsed = authenticationResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new Error("Malformed security-key authentication response");
  }
  const typedResponse = parsed.data as unknown as AuthenticationResponseJSON;

  try {
    // The presented credential MUST belong to the password-identified user —
    // look it up scoped to `userId` so an assertion against another account's
    // key can never satisfy this account's second factor.
    const credential = await prisma.webauthnMfaCredential.findFirst({
      where: { credentialId: typedResponse.id, userId },
    });
    if (!credential) return false;

    const verification: VerifiedAuthenticationResponse =
      await verifyAuthenticationResponse({
        response: typedResponse,
        expectedChallenge: challenge.challenge,
        expectedOrigin: getExpectedOrigin(),
        expectedRPID: getRpId(),
        credential: {
          id: credential.credentialId,
          publicKey: credential.credentialPublicKey,
          counter: Number(credential.counter),
          transports: credential.transports as Transport[],
        },
      });

    if (verification.verified) {
      await prisma.webauthnMfaCredential.update({
        where: { id: credential.id },
        data: {
          counter: BigInt(verification.authenticationInfo.newCounter),
          lastUsedAt: new Date(),
        },
      });
    }

    return verification.verified;
  } finally {
    await prisma.authChallenge
      .delete({ where: { id: challengeId } })
      .catch(() => {});
  }
}

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
  | "ble"
  | "cable"
  | "hybrid"
  | "internal"
  | "nfc"
  | "smart-card"
  | "usb";

const rpName = "HealthLog";

async function cleanupExpiredChallenges() {
  await prisma.authChallenge.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
}

function getConfiguredOrigins(): string[] {
  const candidates = [
    process.env.APP_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    "http://localhost:3000",
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  const validOrigins = candidates
    .map((value) => {
      try {
        return new URL(value).origin;
      } catch {
        return null;
      }
    })
    .filter((value): value is string => Boolean(value));

  return Array.from(new Set(validOrigins));
}

function getRpId(): string {
  const origins = getConfiguredOrigins();
  return new URL(origins[0]).hostname;
}

function getExpectedOrigin(): string | string[] {
  const origins = getConfiguredOrigins();
  return origins.length === 1 ? origins[0] : origins;
}

// ── Registration ─────────────────────────────────────────

export async function createRegistrationOptions(
  userId: string,
  username: string,
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
    excludeCredentials: existingPasskeys.map((pk) => ({
      id: pk.credentialId,
      transports: pk.transports as Transport[],
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });

  // Store challenge with 5-min TTL
  const challenge = await prisma.authChallenge.create({
    data: {
      userId,
      challenge: options.challenge,
      type: "registration",
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    },
  });

  return { options, challengeId: challenge.id };
}

export async function verifyRegistration(
  challengeId: string,
  response: unknown,
): Promise<VerifiedRegistrationResponse> {
  const challenge = await prisma.authChallenge.findUnique({
    where: { id: challengeId },
  });

  if (!challenge || challenge.expiresAt < new Date()) {
    throw new Error("Challenge expired or not found");
  }

  try {
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
    const verification = await verifyRegistrationResponse({
      response: parsed.data as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: getExpectedOrigin(),
      expectedRPID: getRpId(),
    });

    return verification;
  } finally {
    // Invalidate challenge after first verification attempt (success or failure)
    await prisma.authChallenge
      .delete({ where: { id: challengeId } })
      .catch(() => {});
  }
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
    userVerification: "preferred",
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
      // Update counter
      await prisma.passkey.update({
        where: { id: passkey.id },
        data: { counter: BigInt(verification.authenticationInfo.newCounter) },
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

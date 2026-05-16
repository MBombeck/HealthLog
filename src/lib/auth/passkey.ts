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
import { prisma } from "@/lib/db";

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
    // The caller passes a parsed JSON body without prior shape-validation —
    // the SimpleWebAuthn verifier owns full schema validation and throws
    // on any mismatch. We narrow at the boundary so the rest of the file
    // sees the documented `RegistrationResponseJSON` shape.
    const verification = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
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

  // The caller passes a parsed JSON body — narrow at the boundary; the
  // SimpleWebAuthn verifier below performs full shape validation.
  const typedResponse = response as AuthenticationResponseJSON;

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

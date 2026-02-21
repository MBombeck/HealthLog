import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
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

function getRpId(): string {
  const url = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return new URL(url).hostname;
}

function getOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: any,
): Promise<VerifiedRegistrationResponse> {
  const challenge = await prisma.authChallenge.findUnique({
    where: { id: challengeId },
  });

  if (!challenge || challenge.expiresAt < new Date()) {
    throw new Error("Challenge expired or not found");
  }

  try {
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: getOrigin(),
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: any,
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

  // Find the passkey by credential ID
  const credentialId = response.id;
  const passkey = await prisma.passkey.findUnique({
    where: { credentialId },
  });

  if (!passkey) {
    throw new Error("Passkey not found");
  }

  try {
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: getOrigin(),
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

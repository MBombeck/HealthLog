/**
 * Writing a record's Apple Wallet pass (v1.50): its own `WALLET` link and the
 * pass row, in the caller's transaction.
 *
 * The caller mints the link token and the serial number first, because the
 * pass's content (and so `contentHash`) is built from both before anything is
 * stored. Every column is written by name from the input, never by spreading
 * it. The live index on `(user_id, purpose)` refuses a second live WALLET
 * link; the caller turns that P2002 into "a pass already exists".
 */
import type { Prisma, WalletSigner } from "@/generated/prisma/client";

import type { EmergencyCardField } from "../fields";
import type { MintedCardToken } from "../token";

import { sealWalletLinkToken } from "./link-token";

export interface NewWalletPass {
  userId: string;
  /** The owner, or the guardian of a managed profile. */
  createdById: string;
  token: MintedCardToken;
  /** A random UUIDv4. */
  serialNumber: string;
  /** Already normalised (`normaliseFields`). */
  fields: EmergencyCardField[];
  expiresAt: Date | null;
  signer: WalletSigner;
  passTypeIdentifier: string;
  teamIdentifier: string;
  /** The instance's https origin, frozen into the pass. */
  webServiceOrigin: string;
  contentHash: string;
  contentChangedAt: Date;
  consentTextVersion: string;
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function createWalletPass(
  tx: Prisma.TransactionClient,
  input: NewWalletPass,
): Promise<{ linkId: string; walletPassId: string }> {
  if (new URL(input.webServiceOrigin).protocol !== "https:") {
    throw new Error("a wallet pass needs an https origin");
  }
  if (!UUID_V4.test(input.serialNumber)) {
    throw new Error("a wallet pass serial number is a UUIDv4");
  }
  const link = await tx.emergencyCardLink.create({
    data: {
      userId: input.userId,
      createdById: input.createdById,
      tokenHash: input.token.hash,
      tokenPrefix: input.token.prefix,
      purpose: "WALLET",
      tokenEncrypted: sealWalletLinkToken(input.token.raw),
      fields: input.fields,
      expiresAt: input.expiresAt,
    },
    select: { id: true },
  });
  const pass = await tx.walletPass.create({
    data: {
      userId: input.userId,
      createdById: input.createdById,
      linkId: link.id,
      signer: input.signer,
      passTypeIdentifier: input.passTypeIdentifier,
      teamIdentifier: input.teamIdentifier,
      serialNumber: input.serialNumber,
      webServiceOrigin: input.webServiceOrigin,
      contentHash: input.contentHash,
      contentChangedAt: input.contentChangedAt,
      consentTextVersion: input.consentTextVersion,
    },
    select: { id: true },
  });
  return { linkId: link.id, walletPassId: pass.id };
}

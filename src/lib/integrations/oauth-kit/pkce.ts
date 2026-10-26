/**
 * PKCE (RFC 7636, S256) for the providers that take it.
 *
 * The verifier is stashed on the OAuth-state row at connect and presented on
 * the token exchange at callback, never in a cookie or a URL. 64 random bytes
 * give an 86-character base64url verifier, inside the 43 to 128 the RFC
 * allows and well past its 256-bit entropy floor.
 */
import { createHash, randomBytes } from "node:crypto";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

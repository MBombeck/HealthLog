/**
 * The `hlm_` emergency-card credential (v1.49).
 *
 * `hlm_` plus 48 hex characters: 192 random bits, the share link's strength.
 * Only `hashToken(raw)` is stored, under the same `API_TOKEN_HMAC_KEY` as
 * every other HealthLog credential, so rotating that key ends every card link
 * along with every token. The raw token is returned once at mint and cannot
 * be recovered afterwards; the QR code is drawn from it then.
 */
import { randomBytes } from "node:crypto";

import { hashToken } from "@/lib/auth/hmac";

export const CARD_TOKEN_PREFIX = "hlm_";

/** The exact shape a card token has. Anything else is not looked up. */
const CARD_TOKEN_SHAPE = /^hlm_[0-9a-f]{48}$/;

/** How many leading characters the owner's page shows. */
export const CARD_TOKEN_DISPLAY_PREFIX_LENGTH = 8;

export interface MintedCardToken {
  raw: string;
  hash: string;
  prefix: string;
}

export function mintCardToken(): MintedCardToken {
  const raw = `${CARD_TOKEN_PREFIX}${randomBytes(24).toString("hex")}`;
  return {
    raw,
    hash: hashToken(raw),
    prefix: raw.slice(0, CARD_TOKEN_DISPLAY_PREFIX_LENGTH),
  };
}

/** The token from a path segment, or null when it is not one. */
export function parseCardTokenSegment(segment: string): string | null {
  return CARD_TOKEN_SHAPE.test(segment) ? segment : null;
}

/** The public path for a raw token, relative to the instance origin. */
export function cardLinkPath(raw: string): string {
  return `/e/${raw}`;
}

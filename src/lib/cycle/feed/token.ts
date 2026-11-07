/**
 * The `hlf_` calendar-feed credential (#1350).
 *
 * `hlf_` plus 48 hex characters: 192 random bits, the share link's strength.
 * Only `hashToken(raw)` is stored, under the same `API_TOKEN_HMAC_KEY` as every
 * other HealthLog credential, so rotating that key ends every feed URL along
 * with every token (documented in the self-hosting guide). The raw token is
 * returned once at mint and cannot be recovered afterwards.
 */
import { randomBytes } from "node:crypto";

import { hashToken } from "@/lib/auth/hmac";

export const FEED_TOKEN_PREFIX = "hlf_";

/** The exact shape a feed token has. Anything else is not looked up. */
const FEED_TOKEN_SHAPE = /^hlf_[0-9a-f]{48}$/;

/** How many leading characters the settings card shows. */
export const FEED_TOKEN_DISPLAY_PREFIX_LENGTH = 8;

export interface MintedFeedToken {
  raw: string;
  hash: string;
  prefix: string;
}

export function mintFeedToken(): MintedFeedToken {
  const raw = `${FEED_TOKEN_PREFIX}${randomBytes(24).toString("hex")}`;
  return {
    raw,
    hash: hashToken(raw),
    prefix: raw.slice(0, FEED_TOKEN_DISPLAY_PREFIX_LENGTH),
  };
}

/**
 * The token from a path segment, or null when it is not one. A trailing
 * `.ics` is accepted and stripped, because calendar apps are happier with a
 * URL that names its file type.
 */
export function parseFeedTokenSegment(segment: string): string | null {
  const token = segment.endsWith(".ics") ? segment.slice(0, -4) : segment;
  return FEED_TOKEN_SHAPE.test(token) ? token : null;
}

/** The feed path for a raw token, relative to the instance origin. */
export function feedPath(raw: string): string {
  return `/api/cycle/feed/${raw}.ics`;
}

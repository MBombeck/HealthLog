/**
 * What the emergency-card link route shares: the refusals and the status the
 * owner's page may know (v1.49).
 *
 * Management is cookie-only and serves the caller's own record
 * (`requireActorAuth`): the link is a standing credential printed on a card a
 * stranger may scan, so only the person the card is about may make one, from
 * a session, with a fresh proof.
 *
 * The status is the token's prefix, the frozen items and expiry, and the
 * access statistics. Never the hash and never the URL: the URL is returned
 * once, by the mint, which is when the QR code is drawn.
 */
import { apiError } from "@/lib/api-response";
import { prisma } from "@/lib/db";

import type { EmergencyCardField } from "./fields";
import { cardLinkPath } from "./token";

/** Mint, per account. */
export const CARD_LINK_MINT_LIMIT_PER_HOUR = 10;
export const CARD_LINK_MINT_WINDOW_MS = 60 * 60 * 1000;

export function cardLinkUrl(origin: string, raw: string): string {
  return `${origin}${cardLinkPath(raw)}`;
}

export function cardCookieOnlyRefusal(): Response {
  return apiError("The emergency card link is managed on the web", 403, {
    errorCode: "emergency-card.cookie_only",
  });
}

export function cardNoLiveLink(): Response {
  return apiError("No emergency card link is on", 404, {
    errorCode: "emergency-card.none",
  });
}

export function cardLinkExists(): Response {
  return apiError(
    "An emergency card link is already on. Revoke it for a new one.",
    409,
    { errorCode: "emergency-card.exists" },
  );
}

export const CARD_LINK_SUMMARY_SELECT = {
  id: true,
  tokenPrefix: true,
  fields: true,
  expiresAt: true,
  createdAt: true,
  lastAccessAt: true,
  accessCount: true,
} as const;

export interface CardLinkSummaryRow {
  id: string;
  tokenPrefix: string;
  fields: EmergencyCardField[];
  expiresAt: Date | null;
  createdAt: Date;
  lastAccessAt: Date | null;
  accessCount: number;
}

export interface CardLinkSummary {
  tokenPrefix: string;
  fields: EmergencyCardField[];
  expiresAt: string | null;
  createdAt: string;
  lastAccessAt: string | null;
  accessCount: number;
  /** True once `expiresAt` has passed; the link then answers 404. */
  expired: boolean;
}

export function toCardLinkSummary(
  row: CardLinkSummaryRow,
  now: Date = new Date(),
): CardLinkSummary {
  return {
    tokenPrefix: row.tokenPrefix,
    fields: row.fields,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    lastAccessAt: row.lastAccessAt?.toISOString() ?? null,
    accessCount: row.accessCount,
    expired: row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime(),
  };
}

/**
 * The record's live (unrevoked) printed-card link, or null. At most one
 * exists per purpose; a wallet pass's link is not this one.
 */
export function findLiveCardLink(
  userId: string,
): Promise<CardLinkSummaryRow | null> {
  return prisma.emergencyCardLink.findFirst({
    where: { userId, revokedAt: null, purpose: "CARD" },
    select: CARD_LINK_SUMMARY_SELECT,
  });
}

/**
 * The anonymous emergency-card read behind `/e/<hlm_token>` (v1.49).
 *
 * The token in the path is the whole credential: a first responder scans the
 * QR code on a wallet card with any phone and has no session. Everything the
 * read may do is decided here, on every access, in this order:
 *
 *   1. The anonymous auth-surface limit, before anything is looked up, so a
 *      prober walking token space pays for every guess.
 *   2. The token's shape. Anything that is not `hlm_` plus 48 hex is not
 *      looked up at all.
 *   3. The HMAC lookup of a live link: not revoked, not past its expiry.
 *   4. The token's own bucket, so one leaked card cannot be scraped.
 *   5. The record is not pending deletion, and the operator's external-access
 *      switch is on.
 *
 * Every miss is the same null, which the page answers with the same 404.
 * A hit bumps the counters and writes an audit row on the owner's trail, so
 * the owner sees every time the card was opened. The content is read for the
 * frozen items only (`loadEmergencyCard`).
 */
import { activeAccount } from "@/lib/account-deletion/active-account";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { auditLog } from "@/lib/auth/audit";
import { hashToken } from "@/lib/auth/hmac";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { moodDateKey } from "@/lib/mood/date-key";
import { checkAuthSurfaceRateLimit, checkRateLimit } from "@/lib/rate-limit";
import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";

import { loadEmergencyCard, type EmergencyCardView } from "./card-data";
import { parseCardTokenSegment } from "./token";

/** Per source address, across every card. */
const SURFACE_LIMIT_PER_HOUR = 120;
/** Per card: a responder reloading, a colleague scanning again. */
const TOKEN_LIMIT_PER_HOUR = 60;
const HOUR_MS = 60 * 60 * 1000;

export type CardRead =
  | {
      ok: true;
      view: EmergencyCardView;
      /** The owner's calendar day the link stops working, or null. */
      expiresOn: string | null;
    }
  | { ok: false; reason: string };

function miss(reason: string): CardRead {
  annotate({ meta: { emergency_card_miss: reason } });
  return { ok: false, reason };
}

export async function readEmergencyCardByToken(
  request: Request,
  segment: string,
  now: Date = new Date(),
): Promise<CardRead> {
  annotate({ action: { name: "emergency-card.view" } });

  const surface = await checkAuthSurfaceRateLimit(
    request,
    "emergency-card:surface",
    SURFACE_LIMIT_PER_HOUR,
    HOUR_MS,
  );
  if (!surface.allowed) return miss("rate_limited");

  const raw = parseCardTokenSegment(segment);
  if (!raw) return miss("shape");

  const link = await prisma.emergencyCardLink.findUnique({
    where: { tokenHash: hashToken(raw) },
    select: {
      id: true,
      userId: true,
      tokenPrefix: true,
      fields: true,
      expiresAt: true,
      revokedAt: true,
    },
  });
  if (!link || link.revokedAt !== null) return miss("unknown");
  if (link.expiresAt !== null && link.expiresAt.getTime() <= now.getTime()) {
    return miss("expired");
  }

  const perToken = await checkRateLimit(
    `emergency-card:token:${link.id}`,
    TOKEN_LIMIT_PER_HOUR,
    HOUR_MS,
  );
  if (!perToken.allowed) return miss("token_rate_limited");

  const [owner, apiOn] = await Promise.all([
    prisma.user.findFirst({
      where: activeAccount({ id: link.userId }),
      select: { timezone: true },
    }),
    isApiGloballyEnabled(),
  ]);
  if (!owner) return miss("owner");
  if (!apiOn) return miss("api_disabled");

  const tz = owner.timezone ?? DEFAULT_TIMEZONE;
  const today = moodDateKey(now, tz);
  const view = await loadEmergencyCard(link.userId, today, link.fields);

  await prisma.emergencyCardLink.update({
    where: { id: link.id },
    data: { accessCount: { increment: 1 }, lastAccessAt: now },
  });
  await auditLog("emergency-card.link.access", {
    userId: link.userId,
    details: { linkId: link.id, tokenPrefix: link.tokenPrefix },
  });
  return {
    ok: true,
    view,
    expiresOn: link.expiresAt ? userDayKey(link.expiresAt, tz) : null,
  };
}

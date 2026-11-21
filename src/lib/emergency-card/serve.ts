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
 *   4. The record is not pending deletion, and the operator's external-access
 *      switch is on.
 *
 * Every miss is the same null, which the page answers with the same 404.
 * A hit bumps the counters and writes an audit row on the owner's trail, so
 * the owner sees every time the card was opened. The content is read for the
 * frozen items only (`loadEmergencyCard`).
 *
 * Nothing after the lookup refuses a live card for being read often. The card
 * is meant to be opened by whoever holds it, so its link is no secret from a
 * person who has seen it once; a per-card bucket that answered 404 once full
 * let that person lock the card for an hour by reloading it sixty times, which
 * is exactly the hour it might be needed. What a flood costs is bounded
 * instead: the per-address surface limit holds each source address, and the
 * counters and the audit row are written at most `AUDIT_LIMIT_PER_HOUR` times
 * per card and address. Past that the card is still served, and the reload is
 * only annotated, so one address cannot fill the owner's trail, nor hide
 * another address's opening in it.
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

/**
 * Per source address, across every card, before the lookup. A hospital or a
 * mobile carrier puts many people behind one address, so it is set well
 * above what one ward opens in an hour; guessing a 192-bit token gains
 * nothing from it either way.
 */
const SURFACE_LIMIT_PER_HOUR = 600;
/** Per card and address: how many openings are counted and audited. */
const AUDIT_LIMIT_PER_HOUR = 60;
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

  const recorded = await checkRateLimit(
    `emergency-card:audit:${link.id}:${surface.ip ?? "unknown"}`,
    AUDIT_LIMIT_PER_HOUR,
    HOUR_MS,
  );
  if (recorded.allowed) {
    await prisma.emergencyCardLink.update({
      where: { id: link.id },
      data: { accessCount: { increment: 1 }, lastAccessAt: now },
    });
    await auditLog("emergency-card.link.access", {
      userId: link.userId,
      details: { linkId: link.id, tokenPrefix: link.tokenPrefix },
    });
  } else {
    annotate({ meta: { emergency_card_audit_throttled: true } });
  }
  return {
    ok: true,
    view,
    expiresOn: link.expiresAt ? userDayKey(link.expiresAt, tz) : null,
  };
}

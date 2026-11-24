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
 * Every miss is the same null, which `/e/<token>` answers with the same
 * document and a 404 status.
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
import { checkUrlCredentialSurface } from "@/lib/http/url-credential";
import { MS_PER_HOUR } from "@/lib/time-constants";
import { checkRateLimit } from "@/lib/rate-limit";
import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";

import { loadEmergencyCard, type EmergencyCardView } from "./card-data";
import { parseCardTokenSegment } from "./token";
import { guardianMintRefusal } from "@/lib/sharing/guardian-minted";
import { enqueueWalletVoidPush } from "./wallet-pass/queues";
import { voidWalletPassesWhere } from "./wallet-pass/void";

/** Per card and address: how many openings are counted and audited. */
const AUDIT_LIMIT_PER_HOUR = 60;

export type CardRead =
  | {
      ok: true;
      view: EmergencyCardView;
      /** The owner's calendar day the link stops working, or null. */
      expiresOn: string | null;
    }
  | { ok: false; reason: string };

function miss(reason: string): CardRead {
  annotate({ meta: { url_credential_miss: reason } });
  return { ok: false, reason };
}

/** The refusals `cardLinkRefusal` gives before it asks the guardian check. */
const LINK_REFUSALS: ReadonlySet<string> = new Set([
  "unknown",
  "expired",
  "api_disabled",
]);

/**
 * Why a looked-up link would not open right now, or null when it would: it is
 * revoked, past its end, the operator's switch is off, or a guardian's link
 * has lost what admitted it. The scan asks this, and so does the wallet card
 * before it prints the link's QR code, so a card is never printed with a code
 * that already answers nothing.
 */
export async function cardLinkRefusal(
  link: {
    userId: string;
    createdById: string;
    expiresAt: Date | null;
    revokedAt: Date | null;
  },
  apiOn: boolean,
  now: Date,
): Promise<string | null> {
  if (link.revokedAt !== null) return "unknown";
  if (link.expiresAt !== null && link.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  if (!apiOn) return "api_disabled";
  // A guardian's link rests on their live grant and the profile's marker.
  return guardianMintRefusal(link);
}

export async function readEmergencyCardByToken(
  request: Request,
  segment: string,
  now: Date = new Date(),
): Promise<CardRead> {
  annotate({ action: { name: "emergency-card.view" } });

  // The shared per-address limit of the URL-credential surfaces (a ward or
  // a carrier puts many people behind one address).
  const surface = await checkUrlCredentialSurface(
    request,
    "emergency-card:surface",
  );
  if (!surface.allowed) return miss("rate_limited");

  const raw = parseCardTokenSegment(segment);
  if (!raw) return miss("shape");

  // The operator switch is read beside the lookup, not after it, so an
  // unknown token and a known one on a switched-off instance cost the same.
  const [link, apiOn] = await Promise.all([
    prisma.emergencyCardLink.findUnique({
      where: { tokenHash: hashToken(raw) },
      select: {
        id: true,
        userId: true,
        createdById: true,
        tokenPrefix: true,
        purpose: true,
        fields: true,
        expiresAt: true,
        revokedAt: true,
      },
    }),
    isApiGloballyEnabled(),
  ]);
  if (!link) return miss("unknown");
  const refusal = await cardLinkRefusal(link, apiOn, now);
  if (refusal) {
    // A guardian's Wallet pass ends with the right it rested on: stamped
    // withdrawn, and its devices told. Only a guardian refusal ends it; a
    // revoked, expired or switched-off link answers as before.
    if (link.purpose === "WALLET" && !LINK_REFUSALS.has(refusal)) {
      const voided = await prisma.$transaction((tx) =>
        voidWalletPassesWhere(tx, { linkId: link.id }, "GUARDIAN_LOST", now),
      );
      if (voided > 0) await enqueueWalletVoidPush();
    }
    return miss(refusal);
  }
  const owner = await prisma.user.findFirst({
    where: activeAccount({ id: link.userId }),
    select: { timezone: true },
  });
  if (!owner) return miss("owner");

  const tz = owner.timezone ?? DEFAULT_TIMEZONE;
  const today = moodDateKey(now, tz);
  const view = await loadEmergencyCard(link.userId, today, link.fields);

  const recorded = await checkRateLimit(
    `emergency-card:audit:${link.id}:${surface.ip ?? "unknown"}`,
    AUDIT_LIMIT_PER_HOUR,
    MS_PER_HOUR,
  );
  if (recorded.allowed) {
    await prisma.emergencyCardLink.update({
      where: { id: link.id },
      data: { accessCount: { increment: 1 }, lastAccessAt: now },
    });
    await auditLog("emergency-card.link.access", {
      userId: link.userId,
      details: {
        linkId: link.id,
        tokenPrefix: link.tokenPrefix,
        purpose: link.purpose,
      },
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

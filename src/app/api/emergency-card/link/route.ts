/**
 * `/api/emergency-card/link` — the read-only link behind the emergency
 * card's QR code (v1.49).
 *
 *   GET    → the status: token prefix, the items it shows, its expiry and
 *            how often it was opened. Never the hash, never the URL.
 *   POST   → make it. Mints an `hlm_` token, stores only its HMAC, freezes
 *            the ticked items and the expiry, and returns the URL exactly
 *            once (the page draws the QR code from it then).
 *   DELETE → revoke it. The row is stamped, never deleted; a scanned card
 *            answers 404 from then on.
 *
 * Auth: cookie session only, through `requireGuardianAuth()`: the owner on
 * their own record, or the guardian of a managed profile, for the profile's
 * card. A delegate on an adult's record is refused at every grant level.
 * Making a link needs a fresh proof of the person at the keyboard, like every
 * other standing credential.
 */
import { NextRequest } from "next/server";

import {
  apiHandler,
  assertRecentCookieProof,
  requireGuardianAuth,
} from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import {
  emergencyCardLinkCreateSchema,
  normaliseFields,
} from "@/lib/emergency-card/fields";
import {
  CARD_LINK_MINT_LIMIT_PER_HOUR,
  CARD_LINK_MINT_WINDOW_MS,
  CARD_LINK_SUMMARY_SELECT,
  cardCookieOnlyRefusal,
  cardLinkExists,
  cardLinkUrl,
  cardNoLiveLink,
  findLiveCardLink,
  toCardLinkSummary,
} from "@/lib/emergency-card/manage";
import { mintCardToken } from "@/lib/emergency-card/token";
import { resolveOrigin } from "@/lib/http/origin";
import { annotate } from "@/lib/logging/context";
import { isP2002 } from "@/lib/prisma-errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { destroyedDetails } from "@/lib/sharing/audit-details";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

export const GET = apiHandler(async () => {
  const auth = await requireGuardianAuth();
  if (auth.authMethod !== "cookie") return cardCookieOnlyRefusal();
  annotate({ action: { name: "emergency-card.link.status" } });
  const live = await findLiveCardLink(auth.user.id);
  return apiSuccess({ link: live ? toCardLinkSummary(live) : null });
});

export const POST = apiHandler(async (request: NextRequest) => {
  const auth = await requireGuardianAuth();
  if (auth.authMethod !== "cookie") return cardCookieOnlyRefusal();
  const { user, actor } = auth;
  // The proof is the person at the keyboard, so it is the actor's session.
  await assertRecentCookieProof(actor, auth.session.id);
  annotate({ action: { name: "emergency-card.link.create" } });

  // The operator's external-access switch covers this credential too.
  if (!(await isApiGloballyEnabled())) {
    return apiError("API is globally disabled", 403, {
      errorCode: "emergency-card.api_disabled",
    });
  }

  const rl = await checkRateLimit(
    `emergency-card:mint:${actor.id}`,
    CARD_LINK_MINT_LIMIT_PER_HOUR,
    CARD_LINK_MINT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many emergency card links, try again later", 429, {
      errorCode: "emergency-card.rateLimited",
    });
  }

  const parsed = await parseJsonBody(request, emergencyCardLinkCreateSchema, {
    maxBytes: 4 * 1024,
  });
  if (!parsed.ok) return parsed.error;
  const fields = normaliseFields(parsed.data.fields);
  const expiresAt =
    typeof parsed.data.expiresInDays === "number"
      ? new Date(Date.now() + parsed.data.expiresInDays * DAY_MS)
      : null;

  if (await findLiveCardLink(user.id)) return cardLinkExists();

  const minted = mintCardToken();
  let created;
  try {
    created = await prisma.emergencyCardLink.create({
      data: {
        userId: user.id,
        createdById: actor.id,
        tokenHash: minted.hash,
        tokenPrefix: minted.prefix,
        purpose: "CARD",
        fields,
        expiresAt,
      },
      select: CARD_LINK_SUMMARY_SELECT,
    });
  } catch (err) {
    // A second mint racing this one lost to the one-live-link index.
    if (isP2002(err)) return cardLinkExists();
    throw err;
  }

  await auditLog("emergency-card.link.create", {
    userId: user.id,
    details: {
      linkId: created.id,
      tokenPrefix: created.tokenPrefix,
      fields,
      expiresAt: expiresAt?.toISOString() ?? null,
    },
  });

  return apiSuccess(
    {
      url: cardLinkUrl(resolveOrigin(request), minted.raw),
      link: toCardLinkSummary(created),
    },
    201,
  );
});

export const DELETE = apiHandler(async () => {
  const auth = await requireGuardianAuth();
  if (auth.authMethod !== "cookie") return cardCookieOnlyRefusal();
  const { user } = auth;
  annotate({ action: { name: "emergency-card.link.revoke" } });

  const live = await findLiveCardLink(user.id);
  if (!live) return cardNoLiveLink();

  const revokedAt = new Date();
  // The printed card's link only: a wallet pass keeps its own.
  await prisma.emergencyCardLink.updateMany({
    where: { userId: user.id, revokedAt: null, purpose: "CARD" },
    data: { revokedAt },
  });
  await auditLog("emergency-card.link.revoke", {
    userId: user.id,
    details: {
      linkId: live.id,
      ...destroyedDetails({
        model: "EmergencyCardLink",
        id: live.id,
        label: live.tokenPrefix,
        effectiveAt: live.createdAt,
      }),
    },
  });

  return apiSuccess({ revoked: true });
});

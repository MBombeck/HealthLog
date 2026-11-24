/**
 * `POST /api/emergency-card/wallet` — the caller's emergency card as a
 * printable wallet card PDF (v1.49).
 *
 * Body `{ token? }`: the raw `hlm_` token of the caller's live link, which
 * the page holds only in the moment it was made. With it the card carries
 * the link's QR code; the server checks that the token is the caller's own
 * link and that it would open right now (`cardLinkRefusal`, the scan's own
 * check: not revoked, not past its end, the operator's switch on), so the PDF
 * only ever points at the owner's card and never at a code that answers
 * nothing. A card with the code prints the items the link shows, because
 * whoever holds the card is whoever scans it, and the card says the rest is
 * behind the code. Without a token the card prints every item, without a code.
 *
 * The owner's card, or the card of a managed profile for its guardian
 * (`requireGuardianAuth`), cookie session only.
 */
import { NextRequest, NextResponse } from "next/server";

import { apiHandler, requireGuardianAuth } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { hashToken } from "@/lib/auth/hmac";
import { prisma } from "@/lib/db";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { loadEmergencyCard } from "@/lib/emergency-card/card-data";
import {
  EMERGENCY_CARD_FIELDS,
  emergencyWalletBodySchema,
  type EmergencyCardField,
} from "@/lib/emergency-card/fields";
import {
  cardCookieOnlyRefusal,
  cardLinkUrl,
} from "@/lib/emergency-card/manage";
import { cardLinkRefusal } from "@/lib/emergency-card/serve";
import { parseCardTokenSegment } from "@/lib/emergency-card/token";
import { buildWalletCardPdf } from "@/lib/emergency-card/wallet-pdf";
import { resolveOrigin } from "@/lib/http/origin";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { annotate } from "@/lib/logging/context";
import { moodDateKey } from "@/lib/mood/date-key";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const auth = await requireGuardianAuth();
  if (auth.authMethod !== "cookie") return cardCookieOnlyRefusal();
  const { user, actor } = auth;
  annotate({ action: { name: "emergency-card.wallet" } });

  const parsed = await parseJsonBody(request, emergencyWalletBodySchema, {
    maxBytes: 1024,
  });
  if (!parsed.ok) return parsed.error;

  const now = new Date();
  let linkUrl: string | null = null;
  let fields: readonly EmergencyCardField[] = EMERGENCY_CARD_FIELDS;
  if (parsed.data.token !== undefined) {
    const raw = parseCardTokenSegment(parsed.data.token);
    const link = raw
      ? await prisma.emergencyCardLink.findFirst({
          where: {
            userId: user.id,
            tokenHash: hashToken(raw),
            purpose: "CARD",
          },
          select: {
            userId: true,
            createdById: true,
            fields: true,
            expiresAt: true,
            revokedAt: true,
          },
        })
      : null;
    const refusal = link
      ? await cardLinkRefusal(link, await isApiGloballyEnabled(), now)
      : "unknown";
    if (!raw || !link || refusal) {
      return apiError("Not your live emergency card link", 422, {
        errorCode: "emergency-card.wallet.token",
      });
    }
    linkUrl = cardLinkUrl(resolveOrigin(request), raw);
    fields = link.fields;
  }

  const today = moodDateKey(now, user.timezone ?? DEFAULT_TIMEZONE);
  const [card, locale] = await Promise.all([
    loadEmergencyCard(user.id, today, fields),
    // In the language of the person printing it.
    resolveServerLocale({ request, userLocale: actor.locale ?? undefined }),
  ]);
  const { t } = getServerTranslator(locale);
  const bytes = await buildWalletCardPdf({
    view: card,
    t: (k, v) => t(k, v),
    locale,
    linkUrl,
  });
  return new NextResponse(bytes.slice().buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="healthlog-wallet-card-${today}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
});

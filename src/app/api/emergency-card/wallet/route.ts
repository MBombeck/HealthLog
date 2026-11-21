/**
 * `POST /api/emergency-card/wallet` — the caller's emergency card as a
 * printable wallet card PDF (v1.49).
 *
 * Body `{ token? }`: the raw `hlm_` token of the caller's live link, which
 * the page holds only in the moment it was made. With it the card carries
 * the link's QR code; the server checks that the token is the caller's own
 * live link before it prints it, so the PDF can only ever point at the
 * owner's card. Without it the card prints without a code.
 *
 * Always the caller's own record (`requireActorAuth`), cookie session only.
 */
import { NextRequest, NextResponse } from "next/server";

import { apiHandler, requireActorAuth } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { hashToken } from "@/lib/auth/hmac";
import { prisma } from "@/lib/db";
import { loadEmergencyCard } from "@/lib/emergency-card/card-data";
import { emergencyWalletBodySchema } from "@/lib/emergency-card/fields";
import {
  cardCookieOnlyRefusal,
  cardLinkUrl,
} from "@/lib/emergency-card/manage";
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
  const auth = await requireActorAuth();
  if (auth.authMethod !== "cookie") return cardCookieOnlyRefusal();
  const { user } = auth;
  annotate({ action: { name: "emergency-card.wallet" } });

  const parsed = await parseJsonBody(request, emergencyWalletBodySchema, {
    maxBytes: 1024,
  });
  if (!parsed.ok) return parsed.error;

  let linkUrl: string | null = null;
  if (parsed.data.token !== undefined) {
    const raw = parseCardTokenSegment(parsed.data.token);
    const live = raw
      ? await prisma.emergencyCardLink.findFirst({
          where: {
            userId: user.id,
            tokenHash: hashToken(raw),
            revokedAt: null,
          },
          select: { id: true },
        })
      : null;
    if (!raw || !live) {
      return apiError("Not your live emergency card link", 422, {
        errorCode: "emergency-card.wallet.token",
      });
    }
    linkUrl = cardLinkUrl(resolveOrigin(request), raw);
  }

  const today = moodDateKey(new Date(), user.timezone ?? DEFAULT_TIMEZONE);
  const [card, locale] = await Promise.all([
    loadEmergencyCard(user.id, today),
    resolveServerLocale({ request, userLocale: user.locale ?? undefined }),
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

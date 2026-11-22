/**
 * `GET /api/emergency-card/offline` — the caller's emergency card as one
 * self-contained HTML file to keep on the phone (v1.49). No script, no
 * external request, every value escaped (`buildOfflineCardHtml`); it opens
 * with no network. Sent as a download, never rendered in the app's origin.
 *
 * The owner's card, or the card of a managed profile for its guardian
 * (`requireGuardianAuth`), cookie session only.
 */
import { NextRequest, NextResponse } from "next/server";

import { apiHandler, requireGuardianAuth } from "@/lib/api-handler";
import { loadEmergencyCard } from "@/lib/emergency-card/card-data";
import { cardCookieOnlyRefusal } from "@/lib/emergency-card/manage";
import { buildOfflineCardHtml } from "@/lib/emergency-card/offline-html";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { annotate } from "@/lib/logging/context";
import { moodDateKey } from "@/lib/mood/date-key";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  const auth = await requireGuardianAuth();
  if (auth.authMethod !== "cookie") return cardCookieOnlyRefusal();
  const { user } = auth;
  annotate({ action: { name: "emergency-card.offline" } });
  const today = moodDateKey(new Date(), user.timezone ?? DEFAULT_TIMEZONE);
  const [card, locale] = await Promise.all([
    loadEmergencyCard(user.id, today),
    resolveServerLocale({ request, userLocale: user.locale ?? undefined }),
  ]);
  const { t } = getServerTranslator(locale);
  const html = buildOfflineCardHtml(card, (k, v) => t(k, v), locale);
  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="healthlog-emergency-card-${today}.html"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

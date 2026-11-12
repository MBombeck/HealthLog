/**
 * PUT /api/auth/me/locale
 *
 * v1.25.0 — persist the user's UI locale onto `User.locale`.
 *
 * The language switcher historically wrote the choice to localStorage,
 * the `healthlog-locale` cookie and `<html lang>` ONLY — never to the
 * user row. Server-side background work (the proactive Coach nudge, the
 * Telegram test message, …) has no request cookie to read, so it falls
 * back to `User.locale`; with the column left null those messages went
 * out in English regardless of the language the user reads the app in.
 *
 * This setter closes the gap: the client persists the active locale here
 * (on every switch, plus a one-time backfill on mount) so the column
 * reliably mirrors the UI language and the cron paths render in it.
 *
 * Auth: cookie session OR Bearer token.
 * Validation: `{ "locale": "de" }` — must be one of the supported
 * locales; anything else is rejected at the surface so the column never
 * holds a value the resolver would later have to defend against.
 */
import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { apiHandler, requireActorAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, safeJson } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { locales, type Locale } from "@/lib/i18n/config";
import { setLocaleCookie } from "@/lib/i18n/locale-cookie";

export const dynamic = "force-dynamic";

function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" && (locales as readonly string[]).includes(value)
  );
}

export const PUT = apiHandler(async (request: NextRequest) => {
  // An actor surface, and the clearest case for the mode existing at all: the
  // UI language belongs to the person reading the screen, never to the record
  // on it. Under a record scope this would write the delegate's choice onto
  // the OWNER's row and then send the owner's cron mail in a language they may
  // not read — a preference silently transplanted between two people.
  //
  // It has to keep working while a switch is on rather than merely refuse
  // safely: the language switcher fires a mount-time backfill on every page
  // load, including the shared dashboard, and a 403 there breaks switching
  // language for as long as the delegate stays inside the record.
  //
  // This is a WRITE on an actor surface, which is exactly right and worth
  // naming, because the mode carries no method escalation: the row it updates
  // is the caller's own, resolved from their own session, and no grant is
  // consulted or needed.
  const { user } = await requireActorAuth();
  annotate({ action: { name: "user.locale.update" } });

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 4 * 1024,
  });
  if (jsonError) return jsonError;

  const locale = (body as { locale?: unknown } | null)?.locale;
  if (!isLocale(locale)) {
    return apiError("Not a supported locale.", 422);
  }

  // Idempotent: skip the write (and the annotation noise) when the column
  // already matches — the mount-time backfill fires on every page load. A
  // demo is one account every visitor shares, so there the choice stays in
  // this visitor's cookie and never reaches the row the next visitor reads.
  if (user.locale !== locale && process.env.DEMO_MODE !== "true") {
    await prisma.user.update({
      where: { id: user.id },
      data: { locale },
    });
    annotate({ meta: { locale_next: locale } });
  }

  // Mirror the accepted locale into the `healthlog-locale` cookie via
  // Set-Cookie. The client's own `document.cookie` write is capped at 7
  // days by Safari ITP; the server-set copy is not, so an explicit choice
  // survives on every device. Runs on the idempotent path too — the
  // mount-time backfill hitting this route is exactly the weekly refresh
  // that keeps the cookie alive. Harmless no-op payload for Bearer
  // callers (native clients ignore cookies).
  const cookieStore = await cookies();
  setLocaleCookie(cookieStore, locale);

  return apiSuccess({ locale });
});

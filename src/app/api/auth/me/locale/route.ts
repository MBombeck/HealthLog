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
import { LOCALE_COOKIE, setLocaleCookie } from "@/lib/i18n/locale-cookie";

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
  const auth = await requireActorAuth();
  const { user } = auth;
  annotate({ action: { name: "user.locale.update" } });

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 4 * 1024,
  });
  if (jsonError) return jsonError;

  const locale = (body as { locale?: unknown } | null)?.locale;
  if (!isLocale(locale)) {
    return apiError("Not a supported locale.", 422);
  }

  // A browser's statement of its language is the locale cookie: every switch
  // writes it (client `persistLocale`) before this request is sent, and the
  // session read has already copied it onto the column. The body is the
  // language the sending tab happened to render, which is only a choice when
  // it agrees with that cookie. Two ways it does not:
  //
  //   - The cookie says something else. Another tab switched after this one
  //     rendered, or the session read re-emitted the stored choice into a
  //     browser that had none. The body is stale; writing it would put an
  //     older language back over a newer one.
  //   - There is no cookie. Nothing was chosen in this browser, so the page
  //     rendered the Accept-Language guess. A guess may fill an empty column,
  //     never replace a stored choice — or a sign-in on a new device would
  //     reset the account to that device's system language.
  //
  // Either way the reply names the language in force, and the client adopts
  // it. A Bearer caller (the native app) has no cookie and states its choice
  // in the body, so its write stands as before.
  const cookieStore = await cookies();
  const raw = cookieStore.get(LOCALE_COOKIE)?.value;
  const cookieLocale = isLocale(raw) ? raw : null;
  const storedLocale = isLocale(user.locale) ? user.locale : null;

  let inForce: Locale = locale;
  if (auth.authMethod === "cookie") {
    if (cookieLocale && cookieLocale !== locale) inForce = cookieLocale;
    else if (!cookieLocale && storedLocale) inForce = storedLocale;
  }
  if (inForce !== locale) {
    annotate({ meta: { locale_stale: true } });
  }

  // Idempotent: skip the write (and the annotation noise) when the column
  // already matches. A demo is one account every visitor shares, so there the
  // choice stays in this visitor's cookie and never reaches the row the next
  // visitor reads.
  if (user.locale !== inForce && process.env.DEMO_MODE !== "true") {
    await prisma.user.update({
      where: { id: user.id },
      data: { locale: inForce },
    });
    annotate({ meta: { locale_next: inForce } });
  }

  // Set the cookie only where this reply changes it. A reply that repeats
  // the cookie the request carried has nothing to add, and it is not
  // harmless: the request is sent with `keepalive` and can land after the
  // user picked another language in another tab, putting the older one back
  // for the whole browser. Safari's seven-day cap on the script-written
  // cookie does not need this refresh: once the cookie is gone, the session
  // read re-emits the stored choice with a server `Set-Cookie`. Bearer
  // callers ignore cookies, so they get none.
  if (auth.authMethod === "cookie" && cookieLocale !== inForce) {
    setLocaleCookie(cookieStore, inForce);
  }

  return apiSuccess({ locale: inForce });
});

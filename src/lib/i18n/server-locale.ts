import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import {
  defaultLocale,
  locales,
  localeFromLanguageTag,
  type Locale,
} from "./config";

const LOCALE_COOKIE_NAMES = ["healthlog-locale", "userLocale"] as const;

function isLocale(value: string | null | undefined): value is Locale {
  return !!value && (locales as readonly string[]).includes(value);
}

export function pickLocaleFromAcceptLanguage(
  header: string | null,
): Locale | null {
  if (!header) return null;
  // Accept-Language: "en-US,en;q=0.9,de;q=0.8"
  const candidates = header
    .split(",")
    .map((part) => {
      const [tag, qStr] = part.trim().split(";");
      const q = qStr?.startsWith("q=") ? Number(qStr.slice(2)) : 1;
      return {
        tag: tag.trim().toLowerCase(),
        q: Number.isFinite(q) ? q : 0,
      };
    })
    .sort((a, b) => b.q - a.q);

  for (const { tag } of candidates) {
    const locale = localeFromLanguageTag(tag);
    if (locale) return locale;
  }
  return null;
}

interface ResolveOptions {
  /** If a NextRequest is available, the Accept-Language header is read from it. */
  request?: NextRequest | null;
  /** The user-record locale (e.g. User.locale). */
  userLocale?: string | null;
  /** Explicit override (e.g. ?locale= query param). */
  override?: string | null;
}

/**
 * Resolve the active locale for a server-side request.
 *
 * Priority:
 *   1. Explicit override (e.g. `?locale=…` query param).
 *   2. healthlog-locale / userLocale cookie (set by the client when the user
 *      switches language).
 *   3. The User.locale column (persisted preference).
 *   4. Accept-Language header.
 *   5. defaultLocale (English).
 */
export async function resolveServerLocale(
  options: ResolveOptions = {},
): Promise<Locale> {
  if (isLocale(options.override)) return options.override;

  try {
    const cookieStore = await cookies();
    for (const name of LOCALE_COOKIE_NAMES) {
      const value = cookieStore.get(name)?.value;
      if (isLocale(value)) return value;
    }
  } catch {
    // cookies() throws outside a request context — ignore.
  }

  if (isLocale(options.userLocale)) return options.userLocale;

  const accept = options.request?.headers.get("accept-language") ?? null;
  const fromHeader = pickLocaleFromAcceptLanguage(accept);
  if (fromHeader) return fromHeader;

  return defaultLocale;
}

/**
 * #176 — the language a native app request asks for.
 *
 * A browser carries the reader's choice in the locale cookie, which outranks
 * the account's stored language in `resolveServerLocale`. The app has no such
 * cookie: it says which language it runs in through `Accept-Language`, and
 * that header ranks below the stored language there, so an app set to English
 * on an account stored as German got German texts. For a Bearer request the
 * header is the app's own choice and wins; a header naming no shipped
 * language leaves the stored one in charge. Null for a cookie request.
 */
export function nativeRequestLocale(
  authMethod: "cookie" | "bearer",
  request: Pick<Request, "headers">,
): Locale | null {
  if (authMethod !== "bearer") return null;
  return pickLocaleFromAcceptLanguage(request.headers.get("accept-language"));
}

import { cookies, headers } from "next/headers";
import type { NextRequest } from "next/server";
import {
  defaultLocale,
  locales,
  localeFromLanguageTag,
  type Locale,
} from "./config";
import { getOperatorDefaultLocale } from "@/lib/app-settings";

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

/** The request's headers: the one passed in, or the ambient request's. */
async function requestHeaders(
  request: NextRequest | null | undefined,
): Promise<Pick<Headers, "get"> | null> {
  if (request) return request.headers;
  try {
    return await headers();
  } catch {
    // headers() throws outside a request context (a job, a script).
    return null;
  }
}

function isBearerRequest(hdrs: Pick<Headers, "get"> | null): boolean {
  return /^bearer\s/i.test(hdrs?.get("authorization") ?? "");
}

/**
 * Resolve the active locale for a server-side request.
 *
 * Priority:
 *   1. Explicit override (e.g. `?locale=…` query param).
 *   2. On a Bearer request, `Accept-Language` when it names a shipped
 *      language: the app says which language it runs in that way (#176),
 *      and a token request carries no locale cookie.
 *   3. healthlog-locale / userLocale cookie (set by the client when the user
 *      switches language).
 *   4. The User.locale column (persisted preference).
 *   5. Accept-Language header.
 *   6. The operator's default language (`resolveJobLocale` falls back the
 *      same way), and English only when that is unset as well.
 *
 * The headers are the passed request's, or else the ambient request's, so a
 * route that resolves without handing its request over still hears the
 * header. Most callers never passed it, which is how an app running in German
 * on an account with no stored language got English texts.
 */
export async function resolveServerLocale(
  options: ResolveOptions = {},
): Promise<Locale> {
  if (isLocale(options.override)) return options.override;

  const hdrs = await requestHeaders(options.request);
  const fromHeader = pickLocaleFromAcceptLanguage(
    hdrs?.get("accept-language") ?? null,
  );
  if (fromHeader && isBearerRequest(hdrs)) return fromHeader;

  try {
    // The passed request's own cookies, else the ambient request's.
    const cookieStore = options.request?.cookies ?? (await cookies());
    for (const name of LOCALE_COOKIE_NAMES) {
      const value = cookieStore.get(name)?.value;
      if (isLocale(value)) return value;
    }
  } catch {
    // cookies() throws outside a request context — ignore.
  }

  if (isLocale(options.userLocale)) return options.userLocale;

  if (fromHeader) return fromHeader;

  const operatorDefault = await getOperatorDefaultLocale();
  return isLocale(operatorDefault) ? operatorDefault : defaultLocale;
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

"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { locales, defaultLocale, type Locale } from "./config";
import {
  DISPLAY_TIMEZONE,
  makeFormatters,
  type Formatters,
  type TimeFormatPreference,
  type DateFormatPreference,
} from "../format-locale";
import { readStoredTimeFormat, subscribeTimeFormat } from "../time-format";
import { readStoredDateFormat, subscribeDateFormat } from "../date-format";
import { readStoredTimezone, subscribeTimezone } from "../timezone-mirror";
import { resolveKey } from "./resolve-key";
import { pluralKey } from "./plural";
import {
  getCachedMessages,
  getFallbackMessages,
  loadMessages,
  primeMessages,
  type MessageBundle,
} from "./load-locale";

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /**
   * Non-null while a locale switch is waiting on its message bundle
   * (dynamic import). The switcher uses it for a short pending state;
   * `locale` / `t` only flip once the bundle is in so the UI never
   * renders the new locale with the old (or fallback) strings.
   */
  pendingLocale: Locale | null;
  t: (key: string, params?: Record<string, string | number>) => string;
  /**
   * Plural-aware `t`. Resolves `<baseKey><One|Few|Other>` under the active
   * locale's CLDR rules and passes `count` through as a parameter.
   *
   * Lives on the context rather than as a standalone helper each component
   * imports: `pluralTier` is tiny, but a new module edge from a
   * widely-instantiated component (the dashboard trend tile) gets duplicated
   * into every chunk that contains it, which measured ~78 KB gz across the
   * route chunks. The provider is already in every chunk, so routing through
   * it is free.
   */
  tCount: (
    baseKey: string,
    count: number,
    params?: Record<string, string | number>,
  ) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function detectSystemLocale(): Locale {
  if (typeof window === "undefined") return defaultLocale;
  const browserLang = navigator.language.split("-")[0];
  return (locales as readonly string[]).includes(browserLang)
    ? (browserLang as Locale)
    : defaultLocale;
}

function readLocaleCookie(): Locale | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)healthlog-locale=([^;]+)/);
  const value = match?.[1];
  if (value && (locales as readonly string[]).includes(value)) {
    return value as Locale;
  }
  return null;
}

function getSavedLocale(): Locale | null {
  if (typeof window === "undefined") return null;
  // Cookie wins over localStorage: the root layout already rendered the
  // server HTML using the cookie, so matching the cookie on first client
  // render avoids a hydration flash of the wrong language.
  const fromCookie = readLocaleCookie();
  if (fromCookie) return fromCookie;
  const saved = localStorage.getItem("healthlog-locale");
  if (saved && (locales as readonly string[]).includes(saved)) {
    return saved as Locale;
  }
  return null;
}

// Persist a locale choice everywhere the next render / request reads
// it: localStorage (client preference), cookie (SSR handoff — layout +
// metadata render in the user's language), <html lang>. Called ONLY
// alongside the `setActive` flip so a failed bundle load never leaves
// the persisted locale pointing at strings the UI isn't showing.
function persistLocale(newLocale: Locale) {
  localStorage.setItem("healthlog-locale", newLocale);
  // 1-year expiry, Lax samesite, not HttpOnly so the client continues
  // to own it.
  document.cookie = `healthlog-locale=${newLocale}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
  document.documentElement.lang = newLocale;
}

// v1.25.0 — mirror the active locale onto `User.locale` so server-side
// background work (the proactive Coach nudge, the Telegram test message)
// renders in the user's language. The cookie/localStorage choice is
// invisible to a cron that has no request context; without this write the
// column stays null and those messages fall back to English. Fire-and-forget
// and idempotent on the server: a 401 on a public page, an offline blip or a
// no-op equal value all fail silently and never block the UI flip.
function persistLocaleToServer(newLocale: Locale) {
  void apiFetchRaw("/api/auth/me/locale", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ locale: newLocale }),
    credentials: "same-origin",
    keepalive: true,
  }).catch(() => {
    // Best-effort: the cookie remains the first-paint source of truth, and
    // the next mount retries the backfill.
  });
}

export function I18nProvider({
  children,
  initialLocale,
  initialMessages,
}: {
  children: ReactNode;
  initialLocale?: Locale;
  /**
   * Optional pre-resolved bundle for standalone mounts (tests, embedded
   * providers). The APP no longer passes this: the active bundle reaches
   * the provider through the `load-locale` cache — seeded server-side from
   * the full catalog map during SSR and client-side by the layout's
   * versioned `/i18n/<locale>` boot script — so the catalog is never
   * serialized into the RSC flight payload (it used to be 392 KB of every
   * dashboard document).
   */
  initialMessages?: MessageBundle;
}) {
  // Locale + messages live in ONE state cell so a locale switch flips
  // both atomically — `locale` never points at a bundle that hasn't
  // arrived yet.
  const [active, setActive] = useState<{
    locale: Locale;
    messages: MessageBundle;
  }>(() => {
    // Prefer the server-resolved initial locale to eliminate the hydration
    // flash where the server renders EN ("Loading…") and the client then
    // flips to DE ("Laden…") once localStorage/cookie is read at mount.
    const locale =
      initialLocale && (locales as readonly string[]).includes(initialLocale)
        ? initialLocale
        : (getSavedLocale() ?? detectSystemLocale());
    if (initialMessages && locale === initialLocale) {
      // Seed the switch cache too, so switching away and back is instant.
      // Idempotent, so safe under StrictMode's double initializer call.
      primeMessages(locale, initialMessages);
      return { locale, messages: initialMessages };
    }
    // Cache miss on every ladder rung (boot script failed AND the locale
    // isn't EN-cached): render with an empty bundle for one frame — the
    // backfill effect below dynamic-imports the bundle and flips state.
    // In the app this only happens when the boot script is unreachable
    // (evicted HTTP cache offline); keys render raw briefly rather than
    // in the wrong language.
    return {
      locale,
      messages: getCachedMessages(locale) ?? getFallbackMessages() ?? {},
    };
  });
  const { locale, messages } = active;
  const [pendingLocale, setPendingLocale] = useState<Locale | null>(null);
  // Bumped when the lazily-loaded EN fallback bundle lands so every t()
  // consumer re-renders with the fallback floor in place. The EN catalog is
  // no longer a static import (it cost ~106 KB gz on every route); it loads
  // on demand the first time a key actually misses the active bundle.
  const [, setFallbackTick] = useState(0);
  const fallbackRequestedRef = useRef(false);
  // Tracks the most recent switch request so a slow bundle load can't
  // clobber a newer one (last click wins).
  const requestedLocaleRef = useRef<Locale | null>(null);

  // Degenerate mount (no server-passed bundle, non-EN locale from
  // localStorage / navigator): backfill the bundle asynchronously. In
  // the app this path never runs — the root layout always passes the
  // active locale's messages — but standalone mounts stay correct.
  useEffect(() => {
    if (getCachedMessages(locale)) return;
    let cancelled = false;
    void loadMessages(locale).then((loaded) => {
      if (cancelled) return;
      setActive((prev) =>
        prev.locale === locale ? { locale, messages: loaded } : prev,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  // v1.25.0 — keep `User.locale` in step with the committed UI locale. Runs on
  // mount (backfilling the column for users who set their language before this
  // landed) and on every switch, so the proactive Coach nudge and other
  // cookie-blind background paths render in the language the user reads.
  useEffect(() => {
    persistLocaleToServer(locale);
  }, [locale]);

  const setLocale = useCallback((newLocale: Locale) => {
    if (!(locales as readonly string[]).includes(newLocale)) return;

    const cached = getCachedMessages(newLocale);
    if (cached) {
      requestedLocaleRef.current = null;
      setPendingLocale(null);
      persistLocale(newLocale);
      setActive({ locale: newLocale, messages: cached });
      return;
    }

    requestedLocaleRef.current = newLocale;
    setPendingLocale(newLocale);
    loadMessages(newLocale)
      .then((loaded) => {
        if (requestedLocaleRef.current !== newLocale) return;
        requestedLocaleRef.current = null;
        setPendingLocale(null);
        // Persist atomically with the flip — never before the bundle is
        // in hand, so cookie / <html lang> / localStorage can't drift
        // onto a locale the UI failed to load.
        persistLocale(newLocale);
        setActive({ locale: newLocale, messages: loaded });
      })
      .catch(() => {
        // Bundle fetch failed (offline mid-session, …) — stay on the
        // current locale rather than rendering the new one in EN, and
        // leave cookie / <html lang> / localStorage untouched.
        if (requestedLocaleRef.current !== newLocale) return;
        requestedLocaleRef.current = null;
        setPendingLocale(null);
      });
  }, []);

  // Keep the HTML lang and the cookie in sync with the active locale on
  // mount. The cookie acts as the SSR handoff for the next request.
  useEffect(() => {
    document.documentElement.lang = locale;
    document.cookie = `healthlog-locale=${locale}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
  }, [locale]);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      let value = resolveKey(messages, key);

      // Fallback to English if key missing in current locale
      if (value === undefined && locale !== "en") {
        const fallback = getFallbackMessages();
        if (fallback) {
          value = resolveKey(fallback, key);
        } else if (!fallbackRequestedRef.current) {
          // First miss without the EN floor in hand: fetch it once, then
          // re-render so this key (and any sibling misses) resolve. The
          // locale-integrity guard keeps every locale key-complete, so in
          // practice this path only runs against a drifted cached bundle.
          fallbackRequestedRef.current = true;
          void loadMessages("en")
            .then(() => setFallbackTick((n) => n + 1))
            .catch(() => {
              // Leave the ref set — retrying every render would hammer a
              // dead network; the raw key remains the last resort.
            });
        }
      }

      // Fallback to key itself
      if (value === undefined) {
        return key;
      }

      // Replace {param} placeholders
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          value = value.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
        }
      }

      return value;
    },
    [locale, messages],
  );

  const tCount = useCallback(
    (
      baseKey: string,
      count: number,
      params?: Record<string, string | number>,
    ): string => t(pluralKey(baseKey, count, locale), { count, ...params }),
    [t, locale],
  );

  const value = useMemo(
    () => ({ locale, setLocale, pendingLocale, t, tCount }),
    [locale, setLocale, pendingLocale, t, tCount],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslations() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useTranslations must be used within I18nProvider");
  }
  return context;
}

/**
 * The user's hour-cycle preference (AUTO / H12 / H24), reactive to changes.
 * Backed by the localStorage mirror that `useAuth`'s `/api/auth/me` fetch
 * and the profile time-format select keep in sync with the server value —
 * no QueryClient required in the tree. SSR resolves AUTO.
 */
export function useTimeFormatPreference(): TimeFormatPreference {
  return useSyncExternalStore(
    subscribeTimeFormat,
    readStoredTimeFormat,
    () => "AUTO" as const,
  );
}

/**
 * The user's date-order preference (AUTO / DMY / MDY / YMD), reactive to
 * changes. Backed by the same localStorage-mirror pattern as the hour-cycle
 * preference — `useAuth`'s `/api/auth/me` fetch and the profile date-format
 * select keep it in sync with the server value, no QueryClient required.
 * SSR resolves AUTO.
 */
export function useDateFormatPreference(): DateFormatPreference {
  return useSyncExternalStore(
    subscribeDateFormat,
    readStoredDateFormat,
    () => "AUTO" as const,
  );
}

/**
 * The user's mirrored profile timezone, resolved to a renderable IANA zone:
 * valid mirror value → `DISPLAY_TIMEZONE` (Europe/Berlin). Reactive to
 * mirror changes (profile save, cross-tab, `/api/auth/me` re-fetch) via the
 * same localStorage-mirror pattern as the hour-cycle preference. SSR and the
 * pre-fetch state resolve Berlin — deliberately NO browser-timezone rung
 * (issue #490): the chain must match the server's `resolveUserTimezone`
 * fallback so on-screen times agree with the PDF / exports.
 *
 * Use this wherever a day-boundary or weekday must be derived in the SAME
 * zone `useFormatters()` renders clocks in (e.g. `formatUpdatedLabel`).
 */
export function useDisplayTimezone(): string {
  const stored = useSyncExternalStore(
    subscribeTimezone,
    readStoredTimezone,
    () => "",
  );
  return stored !== "" ? stored : DISPLAY_TIMEZONE;
}

/**
 * Locale-aware formatters tied to the active UI locale. Use for every number,
 * date, and time rendered in the UI so regional conventions (70,5 vs 70.5,
 * 19.02.2026 vs Feb 19, 2026) follow the user's language choice. Times honour
 * the per-user hour-cycle preference (AUTO follows the locale, H12 / H24 pin
 * the cycle) and render in the user's profile timezone (issue #490 — the
 * localStorage mirror `fetchMe` keeps in sync; "" falls back to Berlin
 * inside `makeFormatters`).
 */
export function useFormatters(): Formatters {
  const { locale } = useTranslations();
  const timeFormat = useTimeFormatPreference();
  const dateFormat = useDateFormatPreference();
  const timezone = useSyncExternalStore(
    subscribeTimezone,
    readStoredTimezone,
    () => "",
  );
  return useMemo(
    () => makeFormatters(locale, timezone, timeFormat, dateFormat),
    [locale, timezone, timeFormat, dateFormat],
  );
}

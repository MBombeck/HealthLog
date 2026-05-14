"use client";

import { useState, useSyncExternalStore } from "react";
import { Languages, X } from "lucide-react";
import { isMaintainedLocale, type Locale } from "@/lib/i18n/config";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.4.25 W9e — notice strip for AI-initial locales.
 *
 * HealthLog ships German + English as maintainer-curated translations
 * (the maintainer, Marc, owns both bodies). French, Spanish, Italian
 * and Polish ship as AI-initial translations — they pass the
 * locale-integrity test (full key parity, no empty values, no TODOs)
 * but the prose has not been hand-reviewed for register, regional
 * vocabulary, or domain-specific nuance.
 *
 * This banner renders ONLY on non-maintained locales (FR/ES/IT/PL
 * today) and surfaces a small, dismissible strip at the top of the
 * authenticated app shell. It tells the user the translation is
 * AI-maintained and links to the GitHub translation-feedback issue
 * template so they can contribute fixes back.
 *
 * Dismissal is persisted to localStorage per-locale so a user who
 * dismisses the FR banner does not see it again on next visit, but
 * still sees the IT banner when they switch language.
 *
 * The component returns null (renders nothing) when:
 *   - the active locale is in MAINTAINED_LOCALES, or
 *   - the user has dismissed this locale's banner, or
 *   - we are server-side rendering (no localStorage) — the client
 *     re-evaluates on mount, so the banner appears on second paint
 *     without a hydration mismatch warning.
 */

const STORAGE_PREFIX = "healthlog-i18n-banner-dismissed:";
// v1.4.26 P6-8 — `.github/ISSUE_TEMPLATE/translation.yml` now exists.
// GitHub matches the `?template=` query against the filename; the old
// `.md` filename never resolved (the form file was missing), so the
// link landed users on a blank issue body.
const GITHUB_ISSUE_URL =
  "https://github.com/MBombeck/HealthLog/issues/new?template=translation.yml";

function storageKey(locale: Locale): string {
  return `${STORAGE_PREFIX}${locale}`;
}

function readDismissed(locale: Locale): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(storageKey(locale)) === "1";
  } catch {
    // localStorage unavailable (private mode, quota) — fail open so the
    // banner appears. The user can still hide it for the session.
    return false;
  }
}

// Subscribe is a no-op: we only need React to re-read storage on the
// initial client render, not to react to outside writes. Returning a
// noop unsubscriber is the React-recommended pattern for one-shot
// hydration of a browser-only value (mirrors next/router's locale
// snapshot trick).
const subscribeNoop = () => () => undefined;

export function MaintainershipBanner() {
  const { locale, t } = useTranslations();
  // SSR snapshot: server treats the banner as dismissed so the static
  // markup never paints it. Client mount swaps in the real flag from
  // localStorage during the same render via useSyncExternalStore —
  // no setState-in-effect, no hydration mismatch warning.
  const dismissedFromStorage = useSyncExternalStore<boolean>(
    subscribeNoop,
    () => readDismissed(locale),
    () => true,
  );
  const [sessionDismissed, setSessionDismissed] = useState(false);
  const dismissed = dismissedFromStorage || sessionDismissed;

  if (isMaintainedLocale(locale)) return null;
  if (dismissed) return null;

  const handleDismiss = () => {
    setSessionDismissed(true);
    try {
      window.localStorage.setItem(storageKey(locale), "1");
    } catch {
      // Best-effort persistence — the in-memory `sessionDismissed`
      // flag still hides the banner for the rest of the session.
    }
  };

  return (
    <div
      role="status"
      data-testid="maintainership-banner"
      className="border-border bg-muted/40 text-muted-foreground flex items-start gap-2 border-b px-4 py-2 text-xs sm:items-center"
    >
      <Languages className="mt-0.5 h-3.5 w-3.5 shrink-0 sm:mt-0" aria-hidden />
      <p className="flex-1 leading-snug">
        {t("i18n.maintainershipBanner.notice")}{" "}
        <a
          href={GITHUB_ISSUE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground underline-offset-4 hover:underline"
        >
          {t("i18n.maintainershipBanner.cta")}
        </a>
        .
      </p>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label={t("i18n.maintainershipBanner.dismiss")}
        // 44×44 touch-target floor (WCAG 2.5.5). The icon stays small —
        // the surrounding hit area is what the user actually taps.
        className="hover:text-foreground focus-visible:ring-ring/50 -mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}

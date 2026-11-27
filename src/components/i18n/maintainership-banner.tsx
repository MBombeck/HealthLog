"use client";

import { useState } from "react";
import { Languages, X } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useDismissedHints } from "@/hooks/use-dismissed-hints";
import { hintId } from "@/lib/hints/dismissible-hints";
import { isMaintainedLocale } from "@/lib/i18n/config";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.4.25 — notice strip for machine-translated locales.
 *
 * HealthLog ships German + English as maintainer-curated translations
 * (the maintainer owns both bodies). French, Spanish, Italian
 * and Polish ship as machine translations — they pass the
 * locale-integrity test (full key parity, no empty values, no TODOs)
 * but the prose has not been hand-reviewed for register, regional
 * vocabulary, or domain-specific nuance.
 *
 * This banner renders ONLY on non-maintained locales (FR/ES/IT/PL/KO
 * today) and surfaces a small, dismissible strip at the top of the
 * authenticated app shell. It tells the user the translation is
 * machine-translated and links to the GitHub translation-feedback issue
 * template so they can contribute fixes back.
 *
 * Dismissal is remembered on the account per language
 * (`i18n-banner.<locale>`, `useDismissedHints`), so a user who dismisses the
 * FR banner does not see it again on any device, but still sees the IT
 * banner when they switch language.
 *
 * The component returns null (renders nothing) when:
 *   - the active locale is in MAINTAINED_LOCALES, or
 *   - the user has dismissed this locale's banner, or
 *   - the account has not loaded yet, so a dismissed banner never
 *     paints and then disappears.
 */

// v1.4.26 — `.github/ISSUE_TEMPLATE/translation.yml` now exists.
// GitHub matches the `?template=` query against the filename; the old
// `.md` filename never resolved (the form file was missing), so the
// link landed users on a blank issue body.
const GITHUB_ISSUE_URL =
  "https://github.com/MBombeck/HealthLog/issues/new?template=translation.yml";

export function MaintainershipBanner() {
  const { locale, t } = useTranslations();
  const { user, isLoading } = useAuth();
  const hints = useDismissedHints();
  const [sessionDismissed, setSessionDismissed] = useState(false);
  // Without an account (a refused record view) the close holds for this
  // visit only.
  const dismissed =
    sessionDismissed ||
    isLoading ||
    (user !== null &&
      user !== undefined &&
      hints.isDismissed("i18n-banner", locale));

  if (isMaintainedLocale(locale)) return null;
  if (dismissed) return null;

  const handleDismiss = () => {
    setSessionDismissed(true);
    if (user) void hints.dismiss(hintId("i18n-banner", locale));
  };

  return (
    <div
      role="status"
      data-slot="maintainership-banner"
      data-testid="maintainership-banner"
      className="border-border bg-muted/40 text-muted-foreground flex items-start gap-2 border-b px-4 py-2 text-xs sm:items-center"
    >
      <Languages className="mt-0.5 size-3.5 shrink-0 sm:mt-0" aria-hidden />
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
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

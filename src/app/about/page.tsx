import type { Metadata } from "next";
import Link from "next/link";

import { resolveIntlLocale } from "@/lib/format-locale";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { getServerTranslator } from "@/lib/i18n/server-translator";

/**
 * v1.4.27 B3 — Public about / credits page.
 *
 * Two reasons this page exists:
 *
 *   1. The runtime image bundles MaxMind GeoLite2-City and
 *      GeoLite2-ASN databases for offline IP-to-location and
 *      IP-to-ASN lookups. They ship under the GeoLite End User
 *      License Agreement, which incorporates CC BY-SA 4.0 by
 *      reference and controls over it; both want the attribution
 *      reachable from the running application, not just from the
 *      source repository.
 *   2. A general home for open-source credits as the project
 *      accumulates more third-party data sources (already true for
 *      the upcoming ICD-10 reference table in the iOS Health import
 *      flow).
 *
 * The page mirrors `/privacy` in layout and is reachable without a
 * session — see `src/proxy.ts` PUBLIC_PATHS.
 *
 * Intentional: no TOC. The `/privacy` page carries a collapsible
 * `<details>` table of contents because it has eleven numbered
 * sections that benefit from skim navigation. `/about` is short-form
 * (Project + Credits) and fits the fold on every viewport we ship to,
 * so a TOC would cost a tap to expand for negligible payoff. The
 * scroll-mt-28 anchors stay so deep-links into `#project` /
 * `#credits` still clear the sticky header on iPhones with a notch.
 */

// The edge CSP carries a fresh nonce on every response. Rendering this route
// statically would freeze Next's inline streaming scripts without that
// request nonce, so the browser would reject them and leave only the root
// Suspense fallback visible. Keep the public page request-rendered instead of
// weakening the CSP with `unsafe-inline`.
export const dynamic = "force-dynamic";

const LAST_UPDATED = "2026-08-02";

export const metadata: Metadata = {
  title: "About — HealthLog",
  description:
    "Open-source credits and third-party data attributions for the HealthLog project.",
  robots: { index: true, follow: true },
};

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-28 space-y-3">
      <h2 className="text-xl font-semibold tracking-tight md:text-2xl">
        {title}
      </h2>
      <div className="text-foreground space-y-3 text-sm leading-relaxed md:text-base">
        {children}
      </div>
    </section>
  );
}

export default async function AboutPage() {
  // The headings, the date and the sign-in link follow the reader's locale;
  // the body is the attribution text the licences ask for and stays as
  // written.
  const locale = await resolveServerLocale();
  const { t } = getServerTranslator(locale);
  const lastUpdated = new Intl.DateTimeFormat(resolveIntlLocale(locale), {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(`${LAST_UPDATED}T12:00:00Z`));

  return (
    <div className="bg-background text-foreground min-h-dvh">
      <header className="border-border/60 bg-background/80 sticky top-0 z-10 border-b pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3 md:px-6">
          <Link
            href="/"
            className="text-foreground hover:text-primary inline-flex min-h-11 items-center text-sm font-semibold tracking-tight"
          >
            HealthLog
          </Link>
          <Link
            href="/auth/login"
            className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center text-sm"
          >
            {t("auth.login")}
          </Link>
        </div>
      </header>

      {/*
        v1.4.33 IW9 — `max-w-3xl` is intentional (same rationale as
        `/privacy`): long-form column reads better around 70-80
        chars per line. The dashboard / settings / admin shells use
        `max-w-screen-xl` (1280 px); legal pages stay at 768 px.
      */}
      <main
        id="main-content"
        className="mx-auto max-w-3xl space-y-10 px-4 py-8 md:px-6 md:py-12"
      >
        <div className="space-y-3">
          <p className="text-muted-foreground text-xs tracking-wider uppercase">
            {t("aboutPage.eyebrow")}
          </p>
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
            {t("aboutPage.title")}
          </h1>
          <p className="text-muted-foreground text-sm">
            <time dateTime={LAST_UPDATED}>
              {t("aboutPage.lastUpdated", { date: lastUpdated })}
            </time>
          </p>
        </div>

        <Section id="project" title={t("aboutPage.project")}>
          <p>
            HealthLog is an open-source, self-hostable personal-health-tracking
            application. The source code lives at{" "}
            <a
              href="https://github.com/MBombeck/HealthLog"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-2"
            >
              github.com/MBombeck/HealthLog
            </a>{" "}
            and is licensed under the PolyForm Noncommercial License 1.0.0.
            Releases up to and including v1.15.18 were published under AGPL-3.0
            and stay available under it.
          </p>
        </Section>

        <Section id="credits" title={t("aboutPage.credits")}>
          <p>
            HealthLog stands on a number of open-source libraries and public
            data sources. The list below covers the third-party assets that ship
            with the runtime image and whose licences require an explicit
            attribution.
          </p>

          <h3 className="text-foreground text-base font-semibold md:text-lg">
            MaxMind GeoLite2
          </h3>
          <p>
            This product includes GeoLite2 data created by MaxMind, available
            from{" "}
            <a
              href="https://www.maxmind.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-2"
            >
              www.maxmind.com
            </a>
            . The bundled databases (
            <code className="bg-muted rounded px-1 py-0.5 text-xs">
              GeoLite2-City
            </code>{" "}
            and{" "}
            <code className="bg-muted rounded px-1 py-0.5 text-xs">
              GeoLite2-ASN
            </code>
            ) power the offline IP-to-location and IP-to-carrier lookups that
            decorate the admin login-overview audit table. They are distributed
            under the{" "}
            <a
              href="https://www.maxmind.com/en/geolite/eula"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-2"
            >
              GeoLite End User License Agreement
            </a>
            , which incorporates the{" "}
            <a
              href="https://creativecommons.org/licenses/by-sa/4.0/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-2"
            >
              Creative Commons Attribution-ShareAlike 4.0 International License
            </a>{" "}
            by reference and controls wherever the two disagree. The attribution
            above is what that licence asks for.
          </p>
        </Section>

        <footer
          className="border-border/60 text-muted-foreground mt-12 border-t pt-6 text-xs"
          data-slot="about-footer"
        >
          <p>
            HealthLog — source-available under the{" "}
            <a
              href="https://github.com/MBombeck/HealthLog/blob/main/LICENSE"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground hover:underline"
            >
              PolyForm Noncommercial License 1.0.0
            </a>
            . See{" "}
            <Link
              href="/privacy"
              className="hover:text-foreground hover:underline"
            >
              privacy policy
            </Link>
            .
          </p>
        </footer>
      </main>
    </div>
  );
}

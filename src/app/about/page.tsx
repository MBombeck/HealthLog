import type { Metadata } from "next";
import Link from "next/link";

/**
 * v1.4.27 B3 — Public about / credits page.
 *
 * Two reasons this page exists:
 *
 *   1. The runtime image bundles MaxMind GeoLite2-City and
 *      GeoLite2-ASN databases for offline IP-to-location and
 *      IP-to-ASN lookups. The CC BY-SA 4.0 licence requires the
 *      attribution to be reachable from the running application,
 *      not just the source repository.
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

export const dynamic = "force-static";
export const revalidate = false;

const LAST_UPDATED = "2026-05-15";

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
    <section id={id} className="space-y-3 scroll-mt-28">
      <h2 className="text-xl font-semibold tracking-tight md:text-2xl">
        {title}
      </h2>
      <div className="text-muted-foreground space-y-3 text-sm leading-relaxed md:text-base">
        {children}
      </div>
    </section>
  );
}

export default function AboutPage() {
  return (
    <div className="bg-background text-foreground min-h-dvh">
      <header className="border-border/60 bg-background/80 sticky top-0 z-10 border-b backdrop-blur pt-[env(safe-area-inset-top)]">
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
            Sign in
          </Link>
        </div>
      </header>

      <main
        id="main-content"
        className="mx-auto max-w-3xl space-y-10 px-4 py-8 md:px-6 md:py-12"
      >
        <div className="space-y-3">
          <p className="text-muted-foreground text-xs tracking-wider uppercase">
            About
          </p>
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
            About HealthLog
          </h1>
          <p className="text-muted-foreground text-sm">
            Last updated: {LAST_UPDATED}
          </p>
        </div>

        <Section id="project" title="Project">
          <p>
            HealthLog is an open-source, self-hostable personal-health-tracking
            application. The source code lives at{" "}
            <a
              href="https://github.com/MBombeck/HealthLog"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              github.com/MBombeck/HealthLog
            </a>{" "}
            and is licensed under the GNU Affero General Public License v3.0.
          </p>
        </Section>

        <Section id="credits" title="Credits">
          <p>
            HealthLog stands on a number of open-source libraries and public
            data sources. The list below covers the third-party assets that
            ship with the runtime image and whose licences require an explicit
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
              className="text-primary hover:underline"
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
            decorate the admin login-overview audit table. They are
            distributed under the{" "}
            <a
              href="https://creativecommons.org/licenses/by-sa/4.0/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Creative Commons Attribution-ShareAlike 4.0 International
              License
            </a>
            .
          </p>
        </Section>

        <footer
          className="border-border/60 mt-12 border-t pt-6 text-xs text-muted-foreground"
          data-slot="about-footer"
        >
          <p>
            HealthLog — open source under{" "}
            <a
              href="https://github.com/MBombeck/HealthLog/blob/main/LICENSE"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground hover:underline"
            >
              AGPL-3.0
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

import Link from "next/link";

import { Logo } from "@/components/ui/logo";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { getServerTranslator } from "@/lib/i18n/server-translator";

/**
 * v1.4.27 MB6 — branded 404 page. Next.js mounts this file for any
 * route that doesn't resolve to a server component, so the previous
 * implicit fallback was the framework's bare "404" text. The shape
 * here intentionally stays lighter than `<ErrorDetails>` — Decision L
 * in the v1.4.27 mobile-fix plan — because a missing URL is not an
 * application error and doesn't need the bug-report path. Just a
 * branded splash with one link home.
 *
 * Mobile-first: `min-h-dvh` follows the dynamic viewport so the
 * panel anchors centred under iOS Safari's animated URL bar;
 * `safe-area-inset-top` keeps the headline clear of the notch or
 * Dynamic Island.
 *
 * v1.4.43 QoL — copy lifted into i18n keys (`notFound.title` /
 * `notFound.backToDashboard`) and tightened. The previous
 * marketing-flavoured paragraph ("The page you were looking for…
 * Head back to the dashboard to pick up where you left off.") read
 * heavier than the surface warrants; the single-line statement
 * matches the existing voice of every other in-app error message.
 * Translations cover all six locales so a German user no longer
 * lands on English copy.
 */
export default async function NotFound() {
  const locale = await resolveServerLocale();
  const { t } = getServerTranslator(locale);

  return (
    <main
      id="main-content"
      className="bg-background text-foreground flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-12 pt-[calc(env(safe-area-inset-top)+3rem)]"
    >
      <div className="bg-primary/10 flex h-14 w-14 items-center justify-center rounded-xl">
        <Logo className="text-primary" size={32} />
      </div>
      <div className="max-w-sm space-y-2 text-center">
        <p className="text-muted-foreground text-xs tracking-wider uppercase">
          404
        </p>
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
          {t("notFound.title")}
        </h1>
      </div>
      <Link
        href="/"
        className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex min-h-11 items-center justify-center rounded-md px-5 text-sm font-medium transition-colors"
      >
        {t("notFound.backToDashboard")}
      </Link>
    </main>
  );
}

/**
 * The read-only emergency card behind a wallet card's QR code.
 *
 * A standalone RSC at `/e/<token>` with no app chrome, no session and no
 * client bundle of its own: a first responder scans the code with any phone.
 * The `hlm_` token in the path is the only credential, resolved through
 * `readEmergencyCardByToken` (rate limit before the lookup, HMAC lookup, the
 * revocation and expiry, the owner and the operator switch, an audit row on
 * the owner's trail). Every miss is the same flat 404.
 *
 * It shows the items the owner ticked when the link was made, nothing else,
 * and never caches (`no-store` at the edge, `force-dynamic` here, and the
 * service worker keeps `/e/*` out of its page cache).
 */
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/ui/page-header";
import { EmergencyCardSheet } from "@/components/emergency-card/emergency-card-sheet";
import { resolveShareViewLocale } from "@/lib/clinician-share/request-locale";
import { readEmergencyCardByToken } from "@/lib/emergency-card/serve";
import { formatCardDay } from "@/lib/emergency-card/rows";
import { getServerTranslator } from "@/lib/i18n/server-translator";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Emergency card",
  robots: { index: false, follow: false },
};

export default async function EmergencyCardLinkPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const headerList = await headers();
  // The rate limiter reads the trusted-proxy address off request headers.
  const request = new Request("http://localhost/e", {
    headers: new Headers(headerList),
  });
  const read = await readEmergencyCardByToken(request, token);
  if (!read.ok) notFound();

  const locale = await resolveShareViewLocale();
  const { t } = getServerTranslator(locale);
  const tr = (key: string, vars?: Record<string, string | number>) =>
    t(key, vars);

  return (
    <main
      className="bg-background text-foreground mx-auto min-h-dvh max-w-xl px-4 py-6"
      data-slot="emergency-card-link"
    >
      <PageHeader
        title={tr("emergencyCard.title")}
        description={tr("emergencyCard.subtitle")}
      />
      <div className="mt-4">
        <EmergencyCardSheet view={read.view} t={tr} locale={locale} />
      </div>
      <p className="text-muted-foreground mt-6 text-xs">
        {read.expiresOn
          ? tr("emergencyCard.link.validUntil", {
              date: formatCardDay(locale, read.expiresOn),
            })
          : tr("emergencyCard.link.readOnly")}
      </p>
    </main>
  );
}

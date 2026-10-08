import Link from "next/link";
import { redirect } from "next/navigation";
import { MailX } from "lucide-react";

import { looksLikeInviteToken } from "@/lib/auth/invite-token";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { getServerTranslator } from "@/lib/i18n/server-translator";

/**
 * v1.17.0 — invite universal-link landing (iOS #16).
 *
 * `https://<host>/invite/<hlv_token>` is the URL encoded in the admin
 * invite QR and the path the AASA `["*"]` matcher hands to the iOS app:
 *   - On an installed iOS app the scene delegate intercepts the
 *     Universal Link before this page ever renders and starts onboarding
 *     registration with the token prefilled. This server component is the
 *     BROWSER fallback only.
 *   - In a browser, the page is a thin, safe redirect onto the existing
 *     `/auth/register?invite=<token>` flow, where the invite banner shows
 *     and the token rides the signup POST exactly as before.
 *
 * Security:
 *   - The `hlv_` shape is validated before the token is ever reflected
 *     into the redirect target — a malformed segment lands on plain
 *     `/auth/register` with no `?invite`, so the page can never echo
 *     attacker-controlled text into the URL.
 *   - The route does NOT touch the database and is NOT an enumeration
 *     oracle: a well-formed-but-unknown token and a well-formed-and-valid
 *     token redirect to the identical target. Whether a token is real is
 *     only ever decided at `POST /api/auth/register`, which keeps its
 *     existing uniform error semantics and rate limit.
 *   - The token is never logged here; the redirect is the only effect.
 *
 * The route is listed in `PUBLIC_PATHS` (`/invite/`) so an unauthenticated
 * visitor reaches it without the auth-gate bounce to `/auth/login`.
 */
export default async function InviteLandingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  if (looksLikeInviteToken(token)) {
    redirect(`/auth/register?invite=${encodeURIComponent(token)}`);
  }

  // Malformed token: say so. This used to fall through to the plain
  // registration form, which on an open instance invited a stranger to sign
  // up and on a closed one refused them without saying why. The shape check
  // is public knowledge and needs no database, so naming a malformed link as
  // invalid leaks nothing about which tokens exist: a well-formed unknown
  // token still goes on to register, where the signup decides.
  const locale = await resolveServerLocale();
  const { t } = getServerTranslator(locale);
  return (
    <main
      id="main-content"
      data-slot="invite-invalid"
      className="bg-background text-foreground flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-12 pt-[calc(env(safe-area-inset-top)+3rem)]"
    >
      <div
        aria-hidden="true"
        className="bg-muted text-muted-foreground flex size-14 items-center justify-center rounded-xl"
      >
        <MailX className="size-6" />
      </div>
      <div className="max-w-md space-y-2 text-center">
        <h1 className="text-2xl font-bold tracking-tight">
          {t("auth.inviteInvalid.title")}
        </h1>
        <p className="text-foreground text-sm">
          {t("auth.inviteInvalid.description")}
        </p>
      </div>
      <Link
        href="/auth/login"
        className="border-border hover:bg-accent inline-flex min-h-11 items-center justify-center rounded-md border px-4 text-sm font-medium transition-colors"
      >
        {t("auth.inviteInvalid.toLogin")}
      </Link>
    </main>
  );
}

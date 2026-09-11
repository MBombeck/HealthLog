"use client";

import { useId, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, LogOut, MailOpen, UserPlus } from "lucide-react";
import { Logo } from "@/components/ui/logo";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordStrength } from "@/components/ui/password-strength";
import { useTranslations } from "@/lib/i18n/context";
import { detectBrowserTimezone } from "@/lib/tz/format";
import { queryKeys } from "@/lib/query-keys";
import { ApiError, apiFetchRaw, apiPost } from "@/lib/api/api-fetch";
import { clearCachesForSessionEnd, useAuth } from "@/hooks/use-auth";

export default function RegisterPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // v1.15.20 — invite deep link (`/auth/register?invite=hlv_…`). The
  // token rides the signup POST so a closed-registration instance still
  // admits the invited user; an open instance simply ignores it.
  const inviteToken = searchParams.get("invite");
  const queryClient = useQueryClient();
  // v1.38.19 — an invitation creates a NEW account, so it cannot be accepted
  // from inside a live session; `POST /api/auth/register` refuses one with
  // 409 `already_authenticated`. Rendering the form anyway would let the
  // visitor discover that by filling it in. `isLoading` holds the panel back
  // until the session question is actually answered — failing closed the
  // other way round would flash "you are already signed in" at somebody who
  // is not.
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { t } = useTranslations();
  // v1.4.27 MB3 — explicit error-region id wired to every required
  // input via `aria-describedby` so screen readers pair the validation
  // failure with the offending field instead of announcing it as a
  // standalone alert detached from the form.
  const errorId = useId();
  const errorDescriptor = error ? errorId : undefined;

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      // v1.4.25 W7 — ship the browser-detected timezone with the
      // signup payload. Server validates against the IANA list and
      // falls back to the admin server-default if the value is
      // bogus, so a tampered or proxied request can never poison
      // the user's stored zone.
      const timezone = detectBrowserTimezone();
      await apiPost("/api/auth/register", {
        email,
        username,
        password,
        timezone,
        ...(inviteToken ? { inviteToken } : {}),
      });

      await queryClient.invalidateQueries({ queryKey: queryKeys.auth() });
      router.push("/");
    } catch (err) {
      setError(
        err instanceof ApiError && err.message
          ? err.message
          : t("auth.registerFailed"),
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleSignOut() {
    setError(null);
    setSigningOut(true);
    try {
      await apiFetchRaw("/api/auth/logout", { method: "POST" });
      // Same session-end wipe the shell and the menu do: the QueryClient
      // outlives the navigation on this SPA and the health-data families are
      // not user-scoped, so nothing may survive into the next account.
      clearCachesForSessionEnd(queryClient);
      // Back to this page, invitation intact — NOT to the login screen the
      // generic logout goes to. The point of the trip is to accept the
      // invitation, and the token only rides the URL.
      router.replace(
        inviteToken
          ? `/auth/register?invite=${encodeURIComponent(inviteToken)}`
          : "/auth/register",
      );
      router.refresh();
    } catch {
      setError(t("common.networkError"));
    } finally {
      setSigningOut(false);
    }
  }

  if (isAuthenticated && !authLoading) {
    return (
      <div className="w-full max-w-sm">
        <div className="border-border bg-card rounded-xl border p-6 shadow-lg shadow-black/20 sm:p-8">
          <div
            className="flex flex-col items-center gap-3 text-center"
            data-testid="register-already-signed-in"
          >
            <div className="bg-primary/10 flex h-12 w-12 items-center justify-center rounded-lg">
              <Logo className="text-primary" size={28} />
            </div>
            <h1 className="text-xl font-bold tracking-tight">
              {t("auth.alreadySignedIn.title")}
            </h1>
            <p className="text-muted-foreground text-sm">
              {t("auth.alreadySignedIn.body", {
                username: user?.username ?? "",
              })}
            </p>
          </div>

          {error && (
            <div
              role="alert"
              aria-live="polite"
              className="bg-destructive/10 text-destructive mt-6 rounded-lg p-3 text-sm"
            >
              {error}
            </div>
          )}

          <Button
            type="button"
            size="lg"
            className="mt-8 min-h-11 w-full"
            onClick={handleSignOut}
            disabled={signingOut}
            aria-busy={signingOut || undefined}
            data-testid="register-sign-out"
          >
            {signingOut ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <LogOut className="h-4 w-4" />
            )}
            {t("auth.alreadySignedIn.signOut")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm">
      {/* v1.4.27 MB7 / CF-61 — drop `p-8` to `p-6 sm:p-8` so the
          auth card breathes on Galaxy Fold / Pixel 5 without stealing
          half the visible viewport with padding. Tablet+ keeps the
          generous 32 px padding. */}
      <div className="border-border bg-card rounded-xl border p-6 shadow-lg shadow-black/20 sm:p-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="bg-primary/10 flex h-12 w-12 items-center justify-center rounded-lg">
            <Logo className="text-primary" size={28} />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">
              {t("auth.createAccount")}
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {t("auth.newAccount")}
            </p>
          </div>
        </div>

        {inviteToken && (
          <div
            role="status"
            className="bg-primary/10 text-primary mt-6 flex items-center gap-2 rounded-lg p-3 text-sm"
            data-testid="register-invite-banner"
          >
            <MailOpen className="h-4 w-4 shrink-0" aria-hidden="true" />
            {t("auth.invitedBanner")}
          </div>
        )}

        <form onSubmit={handleRegister} className="mt-8 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">{t("auth.email")}</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("auth.emailPlaceholder")}
              required
              autoComplete="email"
              enterKeyHint="next"
              autoCapitalize="none"
              spellCheck={false}
              aria-required="true"
              aria-invalid={!!error || undefined}
              aria-describedby={errorDescriptor}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="username">{t("auth.username")}</Label>
            <Input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="user"
              required
              autoComplete="username"
              enterKeyHint="next"
              autoCapitalize="none"
              spellCheck={false}
              aria-required="true"
              aria-invalid={!!error || undefined}
              aria-describedby={errorDescriptor}
              minLength={3}
              maxLength={30}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">{t("auth.password")}</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("auth.passwordMinLength")}
              required
              autoComplete="new-password"
              enterKeyHint="go"
              aria-required="true"
              aria-invalid={!!error || undefined}
              aria-describedby={errorDescriptor}
            />
            <PasswordStrength password={password} />
            <p className="text-muted-foreground text-xs">
              {t("auth.passkeySetupLater")}
            </p>
          </div>

          {error && (
            <div
              id={errorId}
              role="alert"
              aria-live="polite"
              className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm"
            >
              {error}
            </div>
          )}

          {/* v1.4.27 MB6 — lift the submit to the 44 px tap-target
              floor and the `lg` size so the primary action stays
              reachable on a narrow viewport without falling under the
              iOS keyboard's accessory bar. */}
          <Button
            type="submit"
            size="lg"
            className="min-h-11 w-full"
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <UserPlus className="h-4 w-4" />
            )}
            {t("auth.register")}
          </Button>

          <p className="text-muted-foreground text-center text-xs">
            {t("auth.hasAccount")}{" "}
            <Link
              href="/auth/login"
              // axe-core `link-in-text-block` requires a visible distinction
              // beyond colour alone (WCAG 1.4.1). The underline stays on
              // always, matching the login page's register link.
              className="text-primary underline"
            >
              {t("auth.login")}
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}

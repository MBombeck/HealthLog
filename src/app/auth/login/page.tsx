"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Lock, Loader2, Shield } from "lucide-react";
import { Logo } from "@/components/ui/logo";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { describePasskeyError } from "@/lib/passkey-errors";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  ApiError,
  apiFetchEnvelope,
  apiGet,
  apiPost,
} from "@/lib/api/api-fetch";
import { MfaLoginStep, type MfaMethod } from "@/components/auth/mfa-login-step";
import { OIDC_MFA_COOKIE, OIDC_MFA_COOKIE_PATH } from "@/lib/auth/oidc-cookie";
import { isDashboardSnapshotEnabled } from "@/lib/dashboard/snapshot-flag";
import { prefetchDashboardSnapshot } from "@/lib/queries/use-dashboard-snapshot";
import { clearOfflineCachesForSessionEnd } from "@/lib/pwa/query-persister";
import { sanitizeSameOriginPath } from "@/lib/url-safety";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { t } = useTranslations();
  const [mode, setMode] = useState<"passkey" | "password">("passkey");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(() => {
    const oidcError = searchParams.get("error");
    if (!oidcError) return null;
    const key: Record<string, string> = {
      oidc_denied: "auth.oidc.errorDenied",
      oidc_no_email: "auth.oidc.errorNoEmail",
      oidc_email_unverified: "auth.oidc.errorEmailUnverified",
      oidc_identity_conflict: "auth.oidc.errorIdentityConflict",
      oidc_registration_disabled: "auth.oidc.errorRegistrationDisabled",
    };
    return t(key[oidcError] ?? "auth.oidc.errorFailed");
  });
  const [loading, setLoading] = useState(false);
  // v1.23 — second step of login when the password response carries
  // `meta.mfaRequired`. Holds the opaque ticket + the factors the account can
  // complete the challenge with.
  const [mfaChallenge, setMfaChallenge] = useState<{
    ticket: string;
    methods: MfaMethod[];
  } | null>(null);
  // Guards the conditional-UI passkey autofill so it starts at most once.
  const autofillStarted = useRef(false);
  // v1.4.27 MB3 — explicit error-region id so the email + password
  // inputs reference the banner via `aria-describedby`. Screen readers
  // pair the error with the field instead of announcing it as a
  // standalone alert detached from the form.
  const errorId = useId();
  const errorDescriptor = error ? errorId : undefined;
  const { data: registrationEnabled } = useQuery({
    queryKey: queryKeys.authRegistrationStatus(),
    queryFn: async () => {
      try {
        const data = await apiGet<{ registrationEnabled?: boolean }>(
          "/api/auth/registration-status",
          { cache: "no-store" },
        );
        return Boolean(data?.registrationEnabled ?? true);
      } catch {
        // Fail open, exactly as the raw `if (!res.ok) return true` did.
        return true;
      }
    },
    staleTime: 60 * 1000,
  });

  const { data: oidcStatus } = useQuery({
    queryKey: queryKeys.authOidcStatus(),
    queryFn: async () => {
      try {
        return await apiGet<{
          enabled?: boolean;
          buttonLabel?: string | null;
          only?: boolean;
        }>("/api/auth/oidc/status", { cache: "no-store" });
      } catch {
        return { enabled: false, buttonLabel: null, only: false };
      }
    },
    staleTime: 60 * 1000,
  });

  function handleOidcLogin() {
    const params = new URLSearchParams({ next: getRedirectTarget() });
    window.location.href = `/api/auth/oidc/login?${params}`;
  }

  function getRedirectTarget(): string {
    return sanitizeSameOriginPath(
      searchParams.get("next"),
      window.location.href,
    );
  }

  // v1.32.11 — first-party web-handoff login (iOS #65). The app opens this page
  // as `/auth/login?flow=native` inside an ASWebAuthenticationSession so the
  // login runs in the self-hoster's real web origin (fixing password autofill +
  // passkeys). It stays true for the whole component so every success path
  // (password, passkey button, passkey autofill, MFA step) routes to completion.
  const isNativeHandoff = searchParams.get("flow") === "native";

  // v1.16.6 first-load waterfall fix — the session cookie exists the
  // moment the login POST resolves, so the dashboard snapshot request
  // can ride in parallel with the route transition + page-chunk
  // download instead of queueing behind the dashboard mount.
  function navigateAfterLogin() {
    // Native web-handoff: hand control back to the app via the server's
    // single-use code mint. Top-level navigation, not router.push — the
    // completion answer is a 302 to `healthlog://login-callback` that only the
    // browser/OS can follow. `next` is meaningless to the app and ignored; the
    // page always requires a fresh interactive login here (no ambient one-click
    // pass), which is exactly what the completion route's freshness rule needs.
    if (isNativeHandoff) {
      window.location.href = "/api/auth/native/complete";
      return;
    }
    // Start the new session from an empty in-memory cache. The root
    // QueryClient is created once and outlives every client-side navigation,
    // so a previous user who closed the tab WITHOUT logging out (no logout
    // fired) leaves their non-user-scoped health-data queries
    // (`["measurements"]`, `["dashboard","snapshot"]`, …) sitting in memory.
    // Clearing here — before any prefetch warms THIS user's data and before we
    // navigate — guarantees a fresh login never inherits another account's
    // cached entries. Logout / expiry clear the same cache from their own
    // boundaries; this covers the no-logout path. `clear()` also drops the
    // stale `["auth","me"]`, so the shell refetches it fresh on mount and the
    // former explicit `invalidateQueries({ queryKey: auth() })` is redundant.
    queryClient.clear();
    // Belt-and-suspenders to match the session-END wipe (logout / 401-expiry):
    // also drop the OFFLINE layers — the IndexedDB query snapshot and the SW
    // data/page caches — so a previous account's persisted dashboard never
    // lingers on disk for the new session. The restore is already per-account
    // bound, but a fresh login on a shared browser should leave nothing of the
    // prior account behind. Order is clear → prefetch → navigate: the wipe is
    // started here (best-effort, like logout) before the prefetch warms THIS
    // user's data, and the persister's 1 s debounce gives the single IDB delete
    // ample headroom to land before the new snapshot is written.
    void clearOfflineCachesForSessionEnd();
    const target = getRedirectTarget();
    if (target === "/" && isDashboardSnapshotEnabled()) {
      prefetchDashboardSnapshot(queryClient);
    }
    router.push(target);
  }

  async function handlePasskeyLogin() {
    setError(null);
    setLoading(true);

    try {
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const { options, challengeId } = await apiPost<{
        options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
        challengeId: string;
      }>("/api/auth/passkey/login-options");

      const credential = await startAuthentication({ optionsJSON: options });

      await apiPost("/api/auth/passkey/login-verify", {
        challengeId,
        credential,
      });

      // `navigateAfterLogin` clears the in-memory cache (cross-user guard) and
      // navigates; the shell refetches `["auth","me"]` fresh on mount.
      navigateAfterLogin();
    } catch (err) {
      // Route rejections carry the envelope error verbatim; everything
      // else (WebAuthn ceremony failures) keeps the descriptive mapping.
      if (err instanceof ApiError) {
        setError(err.message || t("auth.loginFailed"));
      } else {
        const { key, params } = describePasskeyError(err);
        setError(t(key, params));
      }
    } finally {
      setLoading(false);
    }
  }

  async function handlePasswordLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      // Read the envelope `meta` directly: an MFA account gets HTTP 200 with
      // `data: null` + `meta.mfaRequired`, not an error and not a session.
      const { meta } = await apiFetchEnvelope<
        unknown,
        {
          mfaRequired?: boolean;
          mfaTicket?: string;
          methods?: MfaMethod[];
        }
      >("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (meta?.mfaRequired && meta.mfaTicket) {
        setMfaChallenge({
          ticket: meta.mfaTicket,
          methods: meta.methods ?? ["totp", "recovery"],
        });
        return;
      }

      // `navigateAfterLogin` clears the in-memory cache (cross-user guard) and
      // navigates; the shell refetches `["auth","me"]` fresh on mount.
      navigateAfterLogin();
    } catch (err) {
      setError(
        err instanceof ApiError && err.message
          ? err.message
          : t("auth.loginFailed"),
      );
    } finally {
      setLoading(false);
    }
  }

  // OIDC → second-factor handoff. The OAuth callback cannot render UI: for
  // a 2FA-enrolled account it mints the same single-use MFA ticket password
  // login uses and parks it in a short-lived, login-page-scoped cookie
  // (`oidc-cookie.ts` documents why it is readable here). Pick it up once,
  // clear it, and enter the exact same MfaLoginStep the password flow uses —
  // `next` continuation rides the query string as usual.
  useEffect(() => {
    const raw = document.cookie
      .split("; ")
      .find((c) => c.startsWith(`${OIDC_MFA_COOKIE}=`))
      ?.slice(OIDC_MFA_COOKIE.length + 1);
    if (!raw) return;
    document.cookie = `${OIDC_MFA_COOKIE}=; path=${OIDC_MFA_COOKIE_PATH}; max-age=0`;
    try {
      const parsed = JSON.parse(decodeURIComponent(raw)) as {
        ticket?: string;
        methods?: MfaMethod[];
      };
      if (parsed.ticket) {
        // A lazy useState initializer cannot replace this: `document` does
        // not exist during the server render, and seeding client-only state
        // there would desync hydration. Mount-time pickup of an external
        // one-shot store is exactly the effect escape hatch.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setMfaChallenge({
          ticket: parsed.ticket,
          methods: parsed.methods ?? ["totp", "recovery"],
        });
      }
    } catch {
      // Malformed handoff — fall through to the normal login UI.
    }
  }, []);

  // v1.23 — passkey conditional-UI autofill. When the browser supports it,
  // arm a discoverable-credential assertion bound to the username field so a
  // returning user can pick their passkey straight from the autofill prompt.
  // Best-effort: any abort (the user types a password instead) is swallowed.
  // Waits for the OIDC status and stays off entirely under OIDC_ONLY —
  // passkey login is a dead end there (server-enforced), so arming the
  // browser's credential prompt would only dangle a door that is locked.
  useEffect(() => {
    if (oidcStatus === undefined) return;
    if (oidcStatus.only === true) return;
    if (autofillStarted.current) return;
    autofillStarted.current = true;
    let cancelled = false;

    (async () => {
      try {
        const { browserSupportsWebAuthnAutofill, startAuthentication } =
          await import("@simplewebauthn/browser");
        if (!(await browserSupportsWebAuthnAutofill())) return;

        const { options, challengeId } = await apiPost<{
          options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
          challengeId: string;
        }>("/api/auth/passkey/login-options");

        const credential = await startAuthentication({
          optionsJSON: options,
          useBrowserAutofill: true,
        });
        if (cancelled) return;

        await apiPost("/api/auth/passkey/login-verify", {
          challengeId,
          credential,
        });
        // `navigateAfterLogin` clears the in-memory cache (cross-user guard)
        // and navigates; the shell refetches `["auth","me"]` fresh on mount.
        navigateAfterLogin();
      } catch {
        // Autofill aborts (no passkey, user dismisses, password path taken)
        // are normal — stay silent and let the explicit buttons drive login.
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oidcStatus]);

  return (
    <div className="flex w-full max-w-sm flex-col gap-4">
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
            <h1 className="text-xl font-bold tracking-tight">HealthLog</h1>
          </div>
        </div>

        {isNativeHandoff && (
          <div
            data-slot="native-handoff-banner"
            className="bg-primary/10 text-foreground mt-6 rounded-lg p-3 text-center text-sm"
          >
            {t("auth.native.signingInToApp")}
          </div>
        )}

        {mfaChallenge ? (
          <div className="mt-8">
            <MfaLoginStep
              mfaTicket={mfaChallenge.ticket}
              methods={mfaChallenge.methods}
              onSuccess={() => {
                // `navigateAfterLogin` clears the in-memory cache (cross-user
                // guard) and navigates; the shell refetches `["auth","me"]`
                // fresh on mount.
                navigateAfterLogin();
              }}
              onCancel={() => {
                setMfaChallenge(null);
                setError(null);
              }}
            />
          </div>
        ) : (
          <div
            // The login card's own action block. `<main>` around it belongs
            // to the shell and is on screen before this page renders at all,
            // so it is this marker, not the landmark, that says the form has
            // arrived.
            data-slot="login-actions"
            className="mt-8 space-y-4"
          >
            {oidcStatus?.enabled && (
              <Button
                onClick={handleOidcLogin}
                variant={oidcStatus.only ? "default" : "outline"}
                className="min-h-11 w-full"
                size="lg"
              >
                <Shield className="h-4 w-4" />
                {oidcStatus.buttonLabel || t("auth.oidc.signInDefault")}
              </Button>
            )}

            {oidcStatus?.enabled && !oidcStatus.only && (
              <div className="flex items-center gap-3">
                <Separator className="flex-1" />
                <span className="text-muted-foreground text-xs">
                  {t("common.or")}
                </span>
                <Separator className="flex-1" />
              </div>
            )}

            {!oidcStatus?.only && (
              <>
                {/* Phase A5 / B-mobile: bumped from default size (h-9, 36px)
                  to size="lg" so the login CTAs meet WCAG 2.5.5 (44px
                  minimum) on mobile. Login is the most-tapped flow on a
                  fresh install. */}
                <Button
                  onClick={handlePasskeyLogin}
                  className="min-h-11 w-full"
                  size="lg"
                  disabled={loading}
                >
                  {loading && mode === "passkey" ? (
                    <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <KeyRound className="h-4 w-4" />
                  )}
                  {t("auth.loginWithPasskey")}
                </Button>

                <div className="flex items-center gap-3">
                  <Separator className="flex-1" />
                  <span className="text-muted-foreground text-xs">
                    {t("common.or")}
                  </span>
                  <Separator className="flex-1" />
                </div>

                {mode === "passkey" ? (
                  <Button
                    variant="outline"
                    data-testid="login-use-password"
                    className="min-h-11 w-full"
                    size="lg"
                    onClick={() => setMode("password")}
                  >
                    <Lock className="h-4 w-4" />
                    {t("auth.loginWithPassword")}
                  </Button>
                ) : (
                  <form onSubmit={handlePasswordLogin} className="space-y-3">
                    <div className="space-y-2">
                      <Label htmlFor="email">{t("auth.emailOrUsername")}</Label>
                      <Input
                        id="email"
                        type="text"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                        // `webauthn` token arms the conditional-UI passkey
                        // autofill prompt on this field (see the mount effect).
                        autoComplete="username webauthn"
                        inputMode="email"
                        enterKeyHint="next"
                        autoCapitalize="none"
                        spellCheck={false}
                        aria-required="true"
                        aria-invalid={!!error || undefined}
                        aria-describedby={errorDescriptor}
                        placeholder={t("auth.emailOrUsernamePlaceholder")}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="password">{t("auth.password")}</Label>
                      <Input
                        id="password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        autoComplete="current-password"
                        enterKeyHint="go"
                        aria-required="true"
                        aria-invalid={!!error || undefined}
                        aria-describedby={errorDescriptor}
                        placeholder="********"
                      />
                    </div>
                    <Button
                      type="submit"
                      data-testid="login-password-submit"
                      className="min-h-11 w-full"
                      size="lg"
                      disabled={loading}
                    >
                      {loading && mode === "password" ? (
                        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                      ) : (
                        <Lock className="h-4 w-4" />
                      )}
                      {t("auth.login")}
                    </Button>
                    <button
                      type="button"
                      onClick={() => setMode("passkey")}
                      className="text-muted-foreground hover:text-foreground inline-flex min-h-11 w-full items-center justify-center text-center text-xs"
                    >
                      {t("auth.backToPasskey")}
                    </button>
                  </form>
                )}
              </>
            )}

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

            {!oidcStatus?.only && registrationEnabled === true && (
              <p className="text-muted-foreground text-center text-xs">
                {t("auth.noAccount")}{" "}
                <Link
                  href="/auth/register"
                  // axe-core `link-in-text-block` requires a visible
                  // distinction beyond colour alone (WCAG 1.4.1). Forcing
                  // the underline always-on instead of `hover:underline`
                  // satisfies the rule without changing the visual after
                  // hover.
                  className="text-primary underline"
                >
                  {t("auth.register")}
                </Link>
              </p>
            )}
          </div>
        )}
      </div>
      {/* v1.4.26 — discoverable privacy link below the login card.
          App Store reviewers and first-time visitors need a one-click
          path to the policy without signing in. */}
      <p className="text-muted-foreground text-center text-xs">
        <Link
          href="/privacy"
          className="hover:text-foreground underline underline-offset-2"
        >
          {t("auth.privacyPolicy")}
        </Link>
      </p>
    </div>
  );
}

"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, LogOut } from "lucide-react";

import { accessLabel } from "@/components/settings/access/managed-profile-handover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/ui/logo";
import { PasswordStrength } from "@/components/ui/password-strength";
import { clearCachesForSessionEnd, useAuth } from "@/hooks/use-auth";
import { ApiError, apiFetchRaw } from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import {
  useClaimProfile,
  useProfileClaimPreview,
} from "@/lib/queries/use-profile-claim";
import { queryKeys } from "@/lib/query-keys";

/**
 * v1.42 (#959) — the person a managed profile describes takes it over as
 * their own account (`/auth/claim?token=hlp_…`).
 *
 * The page hands the token in from `?token=`; this sends it only in the BODY
 * of the two anonymous requests behind it — the preview, then the claim —
 * never in another URL, a query key or storage.
 *
 * What the person sees before choosing a sign-in is deliberately small: their
 * record's name, who keeps which access for now, and until when the link
 * holds. No health data. The decision about each Guardian comes right after
 * the first sign-in, on the screen the claim lands on.
 */
export function ClaimProfile({ token }: { token: string | null }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { t } = useTranslations();
  const fmt = useFormatters();
  // A resolved account payload is the only positive evidence of a session;
  // see the registration page for why `isAuthenticated` is not used here.
  const { user } = useAuth();
  const preview = useProfileClaimPreview(token, !user);
  const claim = useClaimProfile();

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const errorId = useId();

  const previewStatus =
    preview.error instanceof ApiError ? preview.error.status : null;
  const signedIn = Boolean(user) || previewStatus === 409;
  const usernameReserved = username.toLowerCase().startsWith("managed-");

  async function signOut() {
    setSigningOut(true);
    try {
      await apiFetchRaw("/api/auth/logout", { method: "POST" });
      clearCachesForSessionEnd(queryClient);
      // Back to this page with the link intact: the token only rides the URL.
      router.replace(
        token
          ? `/auth/claim?token=${encodeURIComponent(token)}`
          : "/auth/claim",
      );
      router.refresh();
    } finally {
      setSigningOut(false);
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!token || claim.isPending || usernameReserved) return;
    claim.mutate(
      { token, username, email, password },
      {
        onSuccess: async () => {
          queryClient.removeQueries({
            queryKey: queryKeys.profileClaimPreview(),
          });
          await queryClient.invalidateQueries({ queryKey: queryKeys.auth() });
          router.push("/onboarding/handover");
        },
      },
    );
  }

  if (signedIn) {
    return (
      <ClaimCard testId="claim-signed-in">
        <Header
          title={t("auth.claim.signedInTitle")}
          description={t("auth.claim.signedInBody", {
            username: user?.username ?? "",
          })}
        />
        <Button
          type="button"
          size="lg"
          className="mt-8 min-h-11 w-full"
          onClick={() => void signOut()}
          disabled={signingOut}
          data-slot="claim-sign-out"
        >
          {signingOut ? (
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <LogOut className="size-4" />
          )}
          {t("auth.claim.signOut")}
        </Button>
      </ClaimCard>
    );
  }

  if (!token || previewStatus === 404 || previewStatus === 422) {
    return (
      <ClaimCard testId="claim-invalid">
        <Header
          title={t("auth.claim.invalid")}
          description={t("auth.claim.invalidHint")}
        />
      </ClaimCard>
    );
  }

  if (previewStatus === 403) {
    return (
      <ClaimCard testId="claim-unavailable">
        <Header
          title={t("auth.claim.title")}
          description={t("auth.claim.oidcOnly")}
        />
      </ClaimCard>
    );
  }

  if (preview.isError) {
    return (
      <ClaimCard testId="claim-error">
        <Header
          title={t("auth.claim.title")}
          description={t(
            previewStatus === 429
              ? "auth.claim.errorRateLimit"
              : "auth.claim.errorFailed",
          )}
        />
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="mt-8 min-h-11 w-full"
          onClick={() => void preview.refetch()}
        >
          {t("common.retry")}
        </Button>
      </ClaimCard>
    );
  }

  if (!preview.data) {
    return (
      <ClaimCard testId="claim-loading">
        <p
          role="status"
          className="text-muted-foreground flex items-center justify-center gap-2 text-sm"
        >
          <Loader2
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          {t("auth.claim.loading")}
        </p>
      </ClaimCard>
    );
  }

  const data = preview.data;
  const errorKey = claim.isError ? claimErrorKey(claim.error) : null;
  const errorText =
    claim.error instanceof ApiError &&
    claim.error.status === 422 &&
    claim.error.message
      ? claim.error.message
      : errorKey
        ? t(errorKey)
        : null;

  return (
    <ClaimCard testId="claim-form-card">
      <Header
        title={
          data.displayName
            ? t("auth.claim.titleNamed", { name: data.displayName })
            : t("auth.claim.title")
        }
        description={t("auth.claim.description")}
      />

      <section className="mt-6 space-y-2" data-slot="claim-guardians">
        <h2 className="text-sm font-medium">
          {t("auth.claim.guardiansTitle")}
        </h2>
        {data.guardians.length > 0 ? (
          <ul className="divide-y rounded-lg border">
            {data.guardians.map((guardian) => (
              <li
                key={guardian.grantId}
                data-slot="claim-guardian"
                data-proposal={guardian.proposal}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <span className="min-w-0 truncate text-sm">
                  {guardian.displayName}
                </span>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {accessLabel(t, guardian.proposal)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-muted-foreground text-xs">
          {t("auth.claim.guardiansHint")}
        </p>
      </section>

      <form onSubmit={submit} className="mt-6 space-y-4" data-slot="claim-form">
        <div className="space-y-2">
          <Label htmlFor="claim-username">{t("auth.username")}</Label>
          <Input
            id="claim-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            minLength={3}
            maxLength={30}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={usernameReserved || undefined}
            aria-describedby={`${errorId}-username`}
          />
          <p
            id={`${errorId}-username`}
            className={
              usernameReserved
                ? "text-destructive text-xs"
                : "text-muted-foreground text-xs"
            }
          >
            {usernameReserved
              ? t("auth.claim.usernameReserved")
              : t("auth.claim.usernameHint")}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="claim-email">{t("auth.email")}</Label>
          <Input
            id="claim-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby={`${errorId}-email`}
          />
          <p id={`${errorId}-email`} className="text-muted-foreground text-xs">
            {t("auth.claim.emailHint")}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="claim-password">{t("auth.password")}</Label>
          <Input
            id="claim-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="new-password"
            placeholder={t("auth.passwordMinLength")}
          />
          <PasswordStrength password={password} />
        </div>

        <p className="text-sm">{t("auth.claim.consentNote")}</p>
        <p className="text-muted-foreground text-xs">
          {t("auth.claim.expires", {
            date: fmt.dateTime(new Date(data.expiresAt)),
          })}
        </p>

        {errorText && (
          <div
            id={errorId}
            role="alert"
            aria-live="polite"
            data-slot="claim-error"
            className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm"
          >
            {errorText}
          </div>
        )}

        <Button
          type="submit"
          size="lg"
          className="min-h-11 w-full"
          disabled={claim.isPending || usernameReserved}
          data-slot="claim-submit"
        >
          {claim.isPending ? (
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <KeyRound className="size-4" />
          )}
          {claim.isPending
            ? t("auth.claim.submitting")
            : t("auth.claim.submit")}
        </Button>
      </form>
    </ClaimCard>
  );
}

function ClaimCard({
  testId,
  children,
}: {
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div className="w-full max-w-md py-8">
      <div
        className="border-border bg-card rounded-xl border p-4 shadow-lg shadow-black/20 md:p-6"
        data-testid={testId}
      >
        {children}
      </div>
    </div>
  );
}

function Header({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <div className="bg-primary/10 flex size-12 items-center justify-center rounded-lg">
        <Logo className="text-primary" size={28} />
      </div>
      <h1 className="text-xl font-bold tracking-tight">{title}</h1>
      <p className="text-muted-foreground text-sm">{description}</p>
    </div>
  );
}

/** The message for a refused claim. Exported and pure so it can be pinned. */
export function claimErrorKey(err: unknown): string {
  if (!(err instanceof ApiError)) return "auth.claim.errorOffline";
  if (err.status === 404) return "auth.claim.invalid";
  if (err.status === 409) {
    return err.meta?.errorCode === "auth.already_authenticated"
      ? "auth.claim.signedInTitle"
      : "auth.claim.errorTaken";
  }
  if (err.status === 403) return "auth.claim.oidcOnly";
  if (err.status === 429) return "auth.claim.errorRateLimit";
  return "auth.claim.errorFailed";
}

"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { SetupFrame } from "@/components/onboarding/setup-frame";
import { StepActions } from "@/components/onboarding/step-actions";
import { StepHeading } from "@/components/onboarding/step-heading";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { PasswordStrength } from "@/components/ui/password-strength";
import { ApiError, apiGet, apiPost } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { serverSetupStepper } from "@/lib/admin/server-setup";
import { useTranslations } from "@/lib/i18n/context";
import { loadDocument } from "@/lib/navigation/load-document";
import { queryKeys } from "@/lib/query-keys";
import { detectBrowserTimezone } from "@/lib/tz/format";

/** Inside the auth layout, which brings its own gutter and centring. */
const FRAME_CLASS = "px-0 pt-0 md:pt-6 md:pb-6";

/**
 * The start of a fresh server (1.50), on `/auth/register`, before any
 * session exists: prove the setup code, then create the owner account.
 *
 *   code     the setup code from the server log (no stepper yet)
 *   claimed  "code accepted", one primary: create the owner account (or
 *            continue with single sign-on on a server that only takes that)
 *   account  email, username, password: the first half of the stepper's
 *            "Account" segment; the second factor follows behind the session
 *
 * The page stays public and anonymous, exactly as the first-account lock and
 * the proof cookie expect; the account created here is the admin because it
 * is the first, decided on the server under its lock.
 */
export function OwnerSetup({ proven }: { proven: boolean }) {
  const [phase, setPhase] = useState<"claimed" | "account">("claimed");
  if (!proven) return <SetupCode />;
  return phase === "claimed" ? (
    <Claimed onContinue={() => setPhase("account")} />
  ) : (
    <OwnerAccount />
  );
}

function SetupCode() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const errorId = useId();

  async function submit() {
    if (loading || !token.trim()) return;
    setError(null);
    setLoading(true);
    try {
      await apiPost("/api/auth/register/setup", { setupToken: token.trim() });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.authRegistrationStatus(),
      });
    } catch (err) {
      setError(localizedApiError(err, t, "auth.setup.invalid"));
      setLoading(false);
    }
  }

  return (
    <SetupFrame
      screen="claim"
      flow="server"
      stepper={null}
      className={FRAME_CLASS}
    >
      <form
        className="flex flex-1 flex-col"
        data-slot="first-account-setup"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <StepHeading
          id="owner-setup-code-title"
          title={t("auth.setup.title")}
          description={t("setup.server.claim.body")}
        />
        <div className="space-y-2">
          <Label htmlFor="setup-token">{t("auth.setup.tokenLabel")}</Label>
          <Input
            id="setup-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={!!error || undefined}
            aria-describedby={error ? errorId : undefined}
          />
        </div>
        {error ? (
          <p
            id={errorId}
            role="alert"
            className="text-destructive mt-3 text-sm"
          >
            {error}
          </p>
        ) : null}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        <StepActions
          primary={{
            label: t("auth.setup.submit"),
            onClick: () => void submit(),
            disabled: !token.trim(),
          }}
          pending={loading}
        />
      </form>
    </SetupFrame>
  );
}

function Claimed({ onContinue }: { onContinue: () => void }) {
  const { t } = useTranslations();
  const { data: oidc } = useQuery({
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
  const ssoOnly = oidc?.only === true;

  return (
    <SetupFrame
      screen="claimed"
      flow="server"
      stepper={null}
      className={FRAME_CLASS}
    >
      <section className="flex flex-1 flex-col" data-slot="owner-setup-claimed">
        <StepHeading
          id="owner-setup-claimed-title"
          title={t("auth.setup.title")}
          description={t("setup.server.claim.accepted")}
        />
        <StepActions
          primary={
            ssoOnly
              ? {
                  label: t("setup.server.claim.sso"),
                  onClick: () =>
                    loadDocument(
                      `/api/auth/oidc/login?${new URLSearchParams({
                        next: "/onboarding/server",
                      })}`,
                    ),
                  slot: "owner-setup-sso",
                }
              : {
                  label: t("auth.setup.createFirstAccount"),
                  onClick: onContinue,
                  slot: "owner-setup-create",
                }
          }
        />
      </section>
    </SetupFrame>
  );
}

function OwnerAccount() {
  const { t } = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const errorId = useId();
  const stepper = serverSetupStepper("register");
  const ready =
    email.trim().length > 0 &&
    username.trim().length >= 3 &&
    password.length > 0;

  async function submit() {
    if (!ready || loading) return;
    setError(null);
    setLoading(true);
    try {
      await apiPost("/api/auth/register", {
        email,
        username,
        password,
        timezone: detectBrowserTimezone(),
      });
      queryClient.clear();
      router.replace("/onboarding/server/account-mfa");
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 422 && err.message
          ? err.message
          : localizedApiError(err, t, "auth.registerFailed"),
      );
      setLoading(false);
    }
  }

  const describedBy = error ? errorId : undefined;
  return (
    <SetupFrame
      screen="account"
      flow="server"
      className={FRAME_CLASS}
      stepper={{
        steps: stepper.segments.map((id) => ({
          id,
          label: t(`setup.server.segments.${id}`),
        })),
        current: stepper.current,
        fraction: stepper.fraction,
        countLabel: t("onboarding.shell.stepOf", {
          current: stepper.current + 1,
          total: stepper.segments.length,
        }),
      }}
    >
      <form
        className="flex flex-1 flex-col"
        data-slot="owner-setup-account"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <StepHeading
          id="owner-setup-account-title"
          title={t("auth.setup.createFirstAccount")}
          description={t("setup.server.account.body")}
        />
        <div className="space-y-5">
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
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={!!error || undefined}
              aria-describedby={describedBy}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="username">{t("auth.username")}</Label>
            <Input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              minLength={3}
              maxLength={30}
              aria-invalid={!!error || undefined}
              aria-describedby={describedBy}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">{t("auth.password")}</Label>
            <PasswordInput
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
              aria-invalid={!!error || undefined}
              aria-describedby={describedBy ?? "owner-setup-password-hint"}
            />
            <PasswordStrength password={password} />
            <p
              id="owner-setup-password-hint"
              className="text-muted-foreground text-xs"
            >
              {t("auth.passwordMinLength")}
            </p>
          </div>
        </div>
        {error ? (
          <p
            id={errorId}
            role="alert"
            className="text-destructive mt-4 text-sm"
          >
            {error}
          </p>
        ) : null}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        <StepActions
          primary={{
            label: t("setup.server.account.create"),
            onClick: () => void submit(),
            disabled: !ready,
          }}
          pending={loading}
        />
      </form>
    </SetupFrame>
  );
}

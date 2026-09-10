"use client";

import { useId, useState } from "react";
import { KeyRound, Loader2, Lock, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/lib/i18n/context";
import { ApiError, apiPost } from "@/lib/api/api-fetch";
import { describePasskeyError } from "@/lib/passkey-errors";

export type MfaMethod = "totp" | "recovery" | "webauthn";

/**
 * Second step of login when the password response carried `meta.mfaRequired`.
 *
 * Renders the TOTP code entry by default, with a switch to a recovery code and
 * — when the account has a registered security key — a "use a security key"
 * button that runs the scoped WebAuthn assertion. Each path posts back to the
 * matching verify endpoint and, on success, calls `onSuccess` (the parent
 * finishes the login exactly like a normal sign-in).
 */
export function MfaLoginStep({
  mfaTicket,
  methods,
  onSuccess,
  onCancel,
}: {
  mfaTicket: string;
  methods: MfaMethod[];
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslations();
  const codeFieldId = useId();
  const errorId = useId();
  const rememberId = useId();

  const hasTotp = methods.includes("totp");
  const hasWebauthn = methods.includes("webauthn");

  // Default to a code entry when TOTP is available; otherwise lead with the
  // security-key path (a WebAuthn-only account).
  const [useRecovery, setUseRecovery] = useState(false);
  // v1.23 — "remember this device" opt-in. Off by default (a 2FA-bypass token
  // is opt-in only); a recovery-code login forces it off server-side.
  const [rememberDevice, setRememberDevice] = useState(false);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await apiPost("/api/auth/mfa/verify", {
        mfaTicket,
        method: useRecovery ? "recovery" : "totp",
        code: code.trim(),
        rememberDevice: useRecovery ? false : rememberDevice,
      });
      onSuccess();
    } catch (err) {
      setError(
        err instanceof ApiError && err.message
          ? err.message
          : t("auth.mfa.verifyFailed"),
      );
    } finally {
      setLoading(false);
    }
  }

  async function submitSecurityKey() {
    setError(null);
    setLoading(true);
    try {
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const { options, challengeId } = await apiPost<{
        options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
        challengeId: string;
      }>("/api/auth/mfa/webauthn/verify/options", { mfaTicket });
      const credential = await startAuthentication({ optionsJSON: options });
      await apiPost("/api/auth/mfa/webauthn/verify", {
        mfaTicket,
        challengeId,
        credential,
        rememberDevice,
      });
      onSuccess();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message || t("auth.mfa.verifyFailed"));
      } else {
        const { key, params } = describePasskeyError(err);
        setError(t(key, params));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="mfa-login-step">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="bg-primary/10 flex h-10 w-10 items-center justify-center rounded-lg">
          <ShieldCheck className="text-primary h-5 w-5" />
        </div>
        <h2 className="text-lg font-semibold">{t("auth.mfa.title")}</h2>
        <p className="text-muted-foreground text-sm">
          {useRecovery
            ? t("auth.mfa.recoveryHint")
            : hasTotp
              ? t("auth.mfa.totpHint")
              : t("auth.mfa.securityKeyHint")}
        </p>
      </div>

      {(hasTotp || useRecovery) && (
        <form onSubmit={submitCode} className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor={codeFieldId}>
              {useRecovery
                ? t("auth.mfa.recoveryLabel")
                : t("auth.mfa.codeLabel")}
            </Label>
            <Input
              id={codeFieldId}
              data-testid="mfa-code-input"
              value={code}
              onChange={(e) =>
                setCode(
                  useRecovery
                    ? e.target.value
                    : e.target.value.replace(/\D/g, "").slice(0, 6),
                )
              }
              inputMode={useRecovery ? "text" : "numeric"}
              autoComplete="one-time-code"
              autoFocus
              placeholder={useRecovery ? "XXXXX-XXXXX" : "123456"}
              className="font-mono tracking-widest"
              aria-invalid={!!error || undefined}
              aria-describedby={error ? errorId : undefined}
            />
          </div>
          <Button
            type="submit"
            data-testid="mfa-code-submit"
            className="min-h-11 w-full"
            size="lg"
            disabled={loading || code.trim().length < 6}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <Lock className="h-4 w-4" />
            )}
            {t("auth.mfa.verify")}
          </Button>
        </form>
      )}

      {hasWebauthn && (
        <Button
          type="button"
          variant={hasTotp ? "outline" : "default"}
          className="min-h-11 w-full"
          size="lg"
          onClick={submitSecurityKey}
          disabled={loading}
        >
          <KeyRound className="h-4 w-4" />
          {t("auth.mfa.useSecurityKey")}
        </Button>
      )}

      {/* v1.23 — "remember this device". Hidden on the recovery path (a
          recovery-code login signals a lost device, so trusting the browser
          would be unsafe — the server forces it off there too). */}
      {!useRecovery && (
        <label
          htmlFor={rememberId}
          className="text-muted-foreground flex items-center gap-2 text-sm"
        >
          <Checkbox
            id={rememberId}
            checked={rememberDevice}
            onCheckedChange={(v) => setRememberDevice(v === true)}
          />
          {t("auth.mfa.rememberDevice")}
        </label>
      )}

      {hasTotp && (
        <button
          type="button"
          data-testid="mfa-toggle-recovery"
          onClick={() => {
            setUseRecovery((v) => !v);
            setCode("");
            setError(null);
          }}
          className="text-muted-foreground hover:text-foreground inline-flex min-h-11 w-full items-center justify-center text-center text-xs"
        >
          {useRecovery
            ? t("auth.mfa.useAuthenticator")
            : t("auth.mfa.useRecoveryCode")}
        </button>
      )}

      {error && (
        <div
          id={errorId}
          data-testid="mfa-error"
          role="alert"
          aria-live="polite"
          className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm"
        >
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={onCancel}
        className="text-muted-foreground hover:text-foreground inline-flex min-h-11 w-full items-center justify-center text-center text-xs"
      >
        {t("auth.mfa.backToLogin")}
      </button>
    </div>
  );
}

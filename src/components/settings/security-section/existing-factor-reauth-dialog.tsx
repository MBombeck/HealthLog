"use client";

import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Segmented } from "@/components/ui/segmented";
import { Input } from "@/components/ui/input";
import { useTranslations } from "@/lib/i18n/context";
import { ApiError, apiPost } from "@/lib/api/api-fetch";
import { describePasskeyError } from "@/lib/passkey-errors";

export type ReauthMethod =
  "password" | "oidc" | "totp" | "passkey" | "webauthn";

/**
 * Where the browser goes to confirm at the identity provider: the re-proof
 * start, told to come back to the page it is on now. A `reproof` outcome left
 * on the current address from an earlier round trip is dropped, so the page
 * does not come back announcing the old one.
 */
export function oidcReproofStartUrl(current: {
  pathname: string;
  search: string;
}): string {
  const params = new URLSearchParams(current.search);
  params.delete("reproof");
  const query = params.toString();
  const next = `${current.pathname}${query ? `?${query}` : ""}`;
  return `/api/auth/oidc/reproof?${new URLSearchParams({ next }).toString()}`;
}

/** Leave for the identity provider. The page unloads; nothing resolves. */
export function startOidcReproof(): void {
  window.location.assign(oidcReproofStartUrl(window.location));
}

/** The body the enrollment routes accept as a fresh existing-factor proof. */
export type ExistingFactorProof =
  | { method: "password"; password: string }
  | { method: "totp"; code: string }
  | {
      method: "passkey" | "webauthn";
      challengeId: string;
      credential: unknown;
    };

/**
 * The server answers an enrollment it will not take on the session alone with
 * 401 `auth.reproof.required`. That is the cue to ask for a proof and retry,
 * not an error to show.
 */
export function isReproofRequired(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 401 &&
    err.meta?.errorCode === "auth.reproof.required"
  );
}

const REAUTH_METHODS: readonly ReauthMethod[] = [
  "password",
  "oidc",
  "totp",
  "passkey",
  "webauthn",
];

/**
 * The refusal says the account holds nothing it could re-prove here: no
 * password, passkey or second factor, and no identity provider to confirm at
 * (an account whose provider the operator has since switched off). A dialog
 * would only offer it a password it does not have, so the callers say "sign
 * in again" instead — a fresh sign-in is the proof such an account can give
 * (`Session.createdAt` within five minutes).
 */
export function nothingToReprove(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    Array.isArray(err.meta?.methods) &&
    err.meta.methods.length === 0
  );
}

/**
 * The proofs the refusal says this account can give, or null when it names
 * none. On an account with a second factor the server leaves the password out,
 * so the dialog does not offer a choice that can only be refused.
 */
export function offeredReauthMethods(err: unknown): ReauthMethod[] | null {
  if (!(err instanceof ApiError)) return null;
  const raw = err.meta?.methods;
  if (!Array.isArray(raw)) return null;
  const offered = raw.filter((m): m is ReauthMethod =>
    REAUTH_METHODS.includes(m as ReauthMethod),
  );
  return offered.length > 0 ? offered : null;
}

/**
 * Collect a fresh proof of a credential the account already holds, before a
 * new factor is added. A passkey or security-key assertion begins at the
 * cookie-only `/api/auth/passkey/register-options` re-proof arm, which issues
 * an assertion challenge and nothing else; the resulting proof is handed to
 * `onProof`, which retries the enrollment call with it. The identity provider
 * is not a proof in the body: choosing it leaves the page for the provider and
 * comes back to it, and the action is then repeated by hand.
 */
export function ExistingFactorReauthDialog({
  open,
  onOpenChange,
  methods,
  pending,
  error,
  onProof,
  description,
}: {
  /** Overrides the default "before adding a second factor" sentence. */
  description?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  methods: ReauthMethod[];
  pending: boolean;
  error: string | null;
  onProof: (proof: ExistingFactorProof) => void;
}) {
  const { t } = useTranslations();
  const [method, setMethod] = useState<ReauthMethod>(methods[0] ?? "password");
  const [secret, setSecret] = useState("");
  const [assertionError, setAssertionError] = useState<string | null>(null);
  const [asserting, setAsserting] = useState(false);
  const busy = pending || asserting;
  const shown = assertionError ?? error;

  async function submit() {
    setAssertionError(null);
    if (method === "oidc") {
      setAsserting(true);
      startOidcReproof();
      return;
    }
    if (method === "password") {
      onProof({ method, password: secret });
      return;
    }
    if (method === "totp") {
      onProof({ method, code: secret });
      return;
    }
    setAsserting(true);
    try {
      const webauthn = await import("@simplewebauthn/browser");
      const begun = await apiPost<{
        options: Parameters<
          typeof webauthn.startAuthentication
        >[0]["optionsJSON"];
        challengeId: string;
      }>("/api/auth/passkey/register-options", { method });
      const credential = await webauthn.startAuthentication({
        optionsJSON: begun.options,
      });
      onProof({ method, challengeId: begun.challengeId, credential });
    } catch (err) {
      if (err instanceof ApiError) {
        setAssertionError(err.message);
      } else {
        const { key, params } = describePasskeyError(err);
        setAssertionError(t(key, params));
      }
    } finally {
      setAsserting(false);
    }
  }

  const labels: Record<ReauthMethod, string> = {
    password: t("settings.passkeyReauth.methods.password"),
    oidc: t("settings.passkeyReauth.methods.oidc"),
    totp: t("settings.passkeyReauth.methods.totp"),
    passkey: t("settings.passkeyReauth.methods.passkey"),
    webauthn: t("settings.passkeyReauth.methods.webauthn"),
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) {
          setSecret("");
          setAssertionError(null);
        }
        onOpenChange(next);
      }}
    >
      <AlertDialogContent data-testid="factor-reauth-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("settings.passkeyReauth.title")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {description ?? t("settings.passkeyReauth.factorDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {methods.length > 1 && (
          <Segmented
            mode="toggle"
            stretch
            label={t("settings.passkeyReauth.methodLabel")}
            value={method}
            disabled={busy}
            onChange={(m) => {
              setMethod(m);
              setSecret("");
              setAssertionError(null);
            }}
            options={methods.map((m) => ({ value: m, label: labels[m] }))}
          />
        )}

        {method === "password" && (
          <Input
            type="password"
            data-testid="factor-reauth-password"
            autoComplete="current-password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            placeholder={t("settings.passkeyReauth.currentPassword")}
            aria-label={t("settings.passkeyReauth.currentPassword")}
            autoFocus
          />
        )}
        {method === "totp" && (
          <Input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={secret}
            onChange={(event) =>
              setSecret(event.target.value.replace(/\D/g, ""))
            }
            placeholder={t("settings.passkeyReauth.authenticatorPlaceholder")}
            aria-label={t("settings.passkeyReauth.authenticatorCode")}
            autoFocus
          />
        )}

        {method === "oidc" && (
          <p className="text-sm">{t("settings.passkeyReauth.oidcHint")}</p>
        )}

        {shown && (
          <div
            role="alert"
            className="text-destructive flex items-center gap-2 text-sm"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {shown}
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="factor-reauth-submit"
            disabled={
              busy ||
              ((method === "password" || method === "totp") &&
                secret.length === 0)
            }
            aria-busy={busy || undefined}
            onClick={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {busy && (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            )}
            {method === "oidc"
              ? t("settings.passkeyReauth.continueToProvider")
              : t("settings.passkeyReauth.verifyAndContinue")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

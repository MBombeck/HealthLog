"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field-group";
import { Input } from "@/components/ui/input";
import { apiPost } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { Logo } from "@/components/ui/logo";
import { useRegistrationStatus } from "@/hooks/use-registration-status";

/**
 * The first step on an instance without an account: show the setup token
 * from the server log (`@/lib/auth/setup-token`). Once this browser has proven
 * it, the registration form or the single sign-on creates the first account,
 * which becomes the admin.
 */
export function FirstAccountSetup({
  proven,
  registerLink,
}: {
  proven: boolean;
  /** Offer the link to the registration form (not under SSO-only). */
  registerLink: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const errorId = useId();

  if (proven) {
    return (
      <div
        role="status"
        data-slot="first-account-setup"
        className="bg-primary/10 text-foreground mt-6 rounded-lg p-3 text-sm"
      >
        {t("auth.setup.proven")}{" "}
        {registerLink && (
          <Link href="/auth/register" className="font-medium underline">
            {t("auth.setup.createFirstAccount")}
          </Link>
        )}
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await apiPost("/api/auth/register/setup", { setupToken: token.trim() });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.authRegistrationStatus(),
      });
    } catch (err) {
      setError(localizedApiError(err, t, "auth.setup.invalid"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      data-slot="first-account-setup"
      className="border-border mt-6 space-y-3 rounded-lg border p-4"
    >
      <p className="text-foreground text-sm font-medium">
        {t("auth.setup.title")}
      </p>
      <p className="text-muted-foreground text-xs">{t("auth.setup.body")}</p>
      <FieldGroup htmlFor="setup-token" label={t("auth.setup.tokenLabel")}>
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
      </FieldGroup>
      {error && (
        <div
          id={errorId}
          role="alert"
          className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm"
        >
          {error}
        </div>
      )}
      <Button type="submit" className="min-h-11 w-full" disabled={loading}>
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        ) : (
          <KeyRound className="h-4 w-4" />
        )}
        {t("auth.setup.submit")}
      </Button>
    </form>
  );
}

/** True while the instance has no account and this browser has not shown the token. */
export function useFirstAccountSetupPending(): boolean {
  const { data } = useRegistrationStatus();
  return data?.setupRequired === true && !data.setupProven;
}

/** The registration page's whole card while the setup token is still owed. */
export function FirstAccountSetupCard() {
  return (
    <div className="w-full max-w-sm">
      <div className="border-border bg-card rounded-xl border p-6 shadow-lg shadow-black/20 sm:p-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="bg-primary/10 flex h-12 w-12 items-center justify-center rounded-lg">
            <Logo className="text-primary" size={28} />
          </div>
        </div>
        <FirstAccountSetup proven={false} registerLink={false} />
      </div>
    </div>
  );
}

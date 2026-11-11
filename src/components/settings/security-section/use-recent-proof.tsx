"use client";

import { useMemo, useState, type ReactNode } from "react";

import { useTranslations } from "@/lib/i18n/context";
import { ApiError, apiPost } from "@/lib/api/api-fetch";
import {
  ExistingFactorReauthDialog,
  type ReauthMethod,
} from "./existing-factor-reauth-dialog";
import {
  ReproofCancelledError,
  createRecentProofFlow,
  isProofRefusal,
} from "./recent-proof-flow";

export { ReproofCancelledError };

/**
 * The sentence to show for an error `run` rejected with, or null when there is
 * nothing to show (the dialog was cancelled). Any other error returns
 * `fallback`.
 */
export function recentProofErrorMessage(
  err: unknown,
  fallback: string,
): string | null {
  if (err instanceof ReproofCancelledError) return null;
  if (
    err instanceof ApiError &&
    err.meta?.errorCode === "auth.reproof.sign_in_again"
  ) {
    return err.message;
  }
  return fallback;
}

/**
 * Turn a raw `Response` from a download or upload call site into the
 * `ApiError` the hook recognises, when it is the recent-proof refusal. Any
 * other response is returned untouched for the caller's own handling.
 */
export async function throwIfReproofRequired(res: Response): Promise<Response> {
  if (res.status !== 401) return res;
  let body: { error?: unknown; meta?: unknown } | null = null;
  try {
    body = await res.clone().json();
  } catch {
    return res;
  }
  const meta =
    body && typeof body.meta === "object" && body.meta !== null
      ? (body.meta as Record<string, unknown>)
      : undefined;
  const err = new ApiError(
    typeof body?.error === "string" ? body.error : "",
    401,
    meta,
  );
  if (isProofRefusal(err)) throw err;
  return res;
}

/**
 * Run an action that the server may hold back for a fresh proof.
 *
 * Exports of the whole record, share links, token minting and the admin data
 * actions answer 401 `auth.reproof.required` with `meta.methods` when the
 * session has not signed in or re-proved within five minutes; the
 * fresh-factor routes answer 401 `auth.stepup.required` with `meta.methods`
 * when the second factor is older than that (`isProofRefusal`). `run` catches
 * exactly those refusals, opens the re-proof dialog with the listed methods,
 * posts the proof to `/api/auth/reproof` and runs the action once more. Every
 * other error rejects as usual; a cancelled dialog rejects with
 * `ReproofCancelledError`. `recentProofErrorMessage` maps both for display.
 *
 * An account with nothing to re-prove in place (signed in through single
 * sign-on only) gets no dialog: the refusal is rethrown with a message asking
 * to sign in again.
 */
export function useRecentProof(
  options: {
    /**
     * The dialog's one line on why it asks. Defaults to the sentence for
     * sharing and exporting; the fresh-factor acts (changing who looks after a
     * record, a second factor, the account itself) pass their own.
     */
    description?: string;
  } = {},
): {
  run: <T>(action: () => Promise<T>) => Promise<T>;
  dialog: ReactNode;
} {
  const { t } = useTranslations();
  const [methods, setMethods] = useState<ReauthMethod[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One flow per locale, as the callbacks it replaces were (`[t]`): it holds
  // the waiting action, so it is not rebuilt on every render.
  const { run, prove, cancel } = useMemo(
    () =>
      createRecentProofFlow({
        view: { setMethods, setPending, setError },
        submit: (proof) => apiPost("/api/auth/reproof", proof),
        messages: () => ({
          signInAgain: t("settings.reproof.signInAgain"),
          failed: t("settings.reproof.failed"),
          rateLimited: t("apiErrors.http.rate_limited"),
        }),
      }),
    [t],
  );

  const dialog = (
    <ExistingFactorReauthDialog
      key={methods?.join(",") ?? "closed"}
      open={methods !== null}
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
      methods={methods ?? ["password"]}
      pending={pending}
      error={error}
      onProof={(proof) => void prove(proof)}
      description={options.description ?? t("settings.reproof.description")}
    />
  );

  return { run, dialog };
}

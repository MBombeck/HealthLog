"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Loader2,
  Pencil,
  Trash2,
  Usb,
  X,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { ApiError, apiDelete, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { describePasskeyError } from "@/lib/passkey-errors";
import { formatDate } from "@/lib/format";
import {
  ExistingFactorReauthDialog,
  isReproofRequired,
  offeredReauthMethods,
  type ExistingFactorProof,
  type ReauthMethod,
} from "./existing-factor-reauth-dialog";

export interface WebauthnKeyInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * Turn a refusal into a sentence, with the step-up arm told apart from the rest.
 *
 * Exported because the passkey card next door needs the identical mapping since
 * passkey removal became step-up gated too. The server's own prose there is
 * "Recent second-factor verification required", which is English-only and, for a
 * passkey-only account, not even accurate about which credential to re-prove —
 * so the caller supplies its own sentence and this only decides when to use it.
 *
 * Matched on `meta.errorCode`, and on the whole `auth.stepup` prefix rather than
 * one code: `auth.stepup.required` and `auth.stepup.mfa_not_enrolled` both mean
 * "the gate stopped you", and a card that handled only the first would fall
 * through to raw server prose on the second.
 */
export function describeStepUp(
  err: unknown,
  fallback: string,
  stepUpMsg: string,
): string {
  if (err instanceof ApiError) {
    const code = err.meta?.errorCode;
    if (
      err.status === 401 &&
      typeof code === "string" &&
      code.startsWith("auth.stepup")
    ) {
      return stepUpMsg;
    }
    return err.message || fallback;
  }
  return fallback;
}

export function SecurityKeysCard({
  keys,
  totpEnabled = false,
}: {
  keys: WebauthnKeyInfo[];
  totpEnabled?: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  // Adding a key right after signing in goes straight through; later, the
  // server asks for a fresh proof first (401 `auth.reproof.required`) and the
  // options call is retried with it from the dialog.
  const [reauthOpen, setReauthOpen] = useState(false);
  const [reauthError, setReauthError] = useState<string | null>(null);
  // An account with a second factor confirms with that factor or a passkey;
  // the server refuses a password there and names what it will take.
  const hasSecondFactor = totpEnabled || keys.length > 0;
  const [offeredMethods, setOfferedMethods] = useState<ReauthMethod[] | null>(
    null,
  );
  const reauthMethods: ReauthMethod[] = offeredMethods ?? [
    ...(hasSecondFactor ? [] : (["password"] as const)),
    ...(totpEnabled ? (["totp"] as const) : []),
    "passkey",
    ...(keys.length > 0 ? (["webauthn"] as const) : []),
  ];

  const add = useMutation({
    mutationFn: async (proof?: ExistingFactorProof) => {
      const { startRegistration } = await import("@simplewebauthn/browser");
      const { options, challengeId } = await apiPost<{
        options: Parameters<typeof startRegistration>[0]["optionsJSON"];
        challengeId: string;
      }>("/api/auth/me/mfa/webauthn/register/options", proof);
      const credential = await startRegistration({ optionsJSON: options });
      await apiPost("/api/auth/me/mfa/webauthn/register/verify", {
        challengeId,
        credential,
      });
    },
    onSuccess: () => {
      setError(null);
      setReauthOpen(false);
      setReauthError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.mfaStatus() });
    },
    onError: (err, proof) => {
      if (isReproofRequired(err)) {
        setOfferedMethods(offeredReauthMethods(err));
        setError(null);
        setReauthError(null);
        setReauthOpen(true);
        return;
      }
      let message: string;
      if (err instanceof ApiError) {
        message = err.message || t("settings.security.keys.addFailed");
      } else {
        const { key, params } = describePasskeyError(err);
        message = t(key, params);
      }
      if (proof) {
        setReauthError(message);
      } else {
        setError(message);
      }
    },
  });

  const rename = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      await apiPatch(`/api/auth/me/mfa/webauthn/${id}`, { name });
    },
    onSuccess: () => {
      setEditingId(null);
      setError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.mfaStatus() });
    },
    onError: (err) =>
      setError(
        err instanceof ApiError
          ? err.message
          : t("settings.security.keys.renameFailed"),
      ),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await apiDelete(`/api/auth/me/mfa/webauthn/${id}`);
    },
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.mfaStatus() });
    },
    onError: (err) =>
      setError(
        describeStepUp(
          err,
          t("settings.security.keys.removeFailed"),
          t("settings.security.stepUpRequired"),
        ),
      ),
  });

  return (
    <SettingsCard>
      <SettingsCardHeader
        anchor="security-keys"
        icon={Usb}
        title={t("settings.security.keys.title")}
        description={t("settings.security.keys.description")}
      />

      <div className="space-y-4">
        {keys.length === 0 ? (
          <EmptyState
            variant="plain"
            size="compact"
            title={t("settings.security.keys.empty")}
          />
        ) : (
          <ul className="space-y-2" data-testid="security-keys-list">
            {keys.map((key) => (
              <SettingsCard as="li" key={key.id}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    {editingId === key.id ? (
                      <form
                        className="flex items-center gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          rename.mutate({ id: key.id, name: editName.trim() });
                        }}
                      >
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          maxLength={64}
                          aria-label={t("settings.security.keys.nameLabel")}
                          autoFocus
                        />
                        <Button
                          type="submit"
                          variant="ghost"
                          size="icon"
                          className="min-h-11 min-w-11 shrink-0 sm:h-8 sm:min-h-0 sm:w-8 sm:min-w-0"
                          disabled={
                            rename.isPending || editName.trim().length === 0
                          }
                          aria-label={t("common.save")}
                        >
                          {rename.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                          ) : (
                            <Check className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="min-h-11 min-w-11 shrink-0 sm:h-8 sm:min-h-0 sm:w-8 sm:min-w-0"
                          onClick={() => setEditingId(null)}
                          aria-label={t("common.cancel")}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </form>
                    ) : (
                      <>
                        <p className="truncate text-sm font-medium">
                          {key.name}
                        </p>
                        <p className="text-muted-foreground mt-1 text-xs">
                          {key.lastUsedAt
                            ? t("settings.security.keys.lastUsed", {
                                date: formatDate(key.lastUsedAt),
                              })
                            : t("settings.security.keys.neverUsed")}
                          {" · "}
                          {t("settings.security.keys.added", {
                            date: formatDate(key.createdAt),
                          })}
                        </p>
                      </>
                    )}
                  </div>

                  {editingId !== key.id && (
                    <div className="flex shrink-0 gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="min-h-11 min-w-11 sm:h-8 sm:min-h-0 sm:w-8 sm:min-w-0"
                        onClick={() => {
                          setEditingId(key.id);
                          setEditName(key.name);
                        }}
                        aria-label={t("settings.security.keys.rename")}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground hover:text-foreground min-h-11 min-w-11 sm:h-8 sm:min-h-0 sm:w-8 sm:min-w-0"
                            disabled={remove.isPending}
                            aria-label={t("settings.security.keys.remove")}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              {t("settings.security.keys.remove")}
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              {t("settings.security.keys.removeConfirm")}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>
                              {t("common.cancel")}
                            </AlertDialogCancel>
                            <AlertDialogAction
                              variant="destructive"
                              disabled={remove.isPending}
                              aria-busy={remove.isPending || undefined}
                              onClick={() => remove.mutate(key.id)}
                            >
                              {remove.isPending && (
                                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                              )}
                              {t("common.delete")}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  )}
                </div>
              </SettingsCard>
            ))}
          </ul>
        )}

        {error && (
          <div
            role="alert"
            className="text-destructive flex items-center gap-2 text-sm"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}

        <SettingsCardActions>
          <Button
            type="button"
            className="min-h-11 sm:min-h-9"
            onClick={() => add.mutate(undefined)}
            disabled={add.isPending}
          >
            {add.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <Usb className="h-4 w-4" />
            )}
            {t("settings.security.keys.add")}
          </Button>
        </SettingsCardActions>
        <ExistingFactorReauthDialog
          open={reauthOpen}
          onOpenChange={(open) => {
            setReauthOpen(open);
            if (!open) setReauthError(null);
          }}
          methods={reauthMethods}
          pending={add.isPending}
          error={reauthError}
          onProof={(proof) => add.mutate(proof)}
        />
      </div>
    </SettingsCard>
  );
}

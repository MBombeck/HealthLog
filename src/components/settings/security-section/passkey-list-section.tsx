"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Fingerprint,
  KeyRound,
  Loader2,
  Pencil,
  Trash2,
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { formatDate } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  ApiError,
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
} from "@/lib/api/api-fetch";
import { describePasskeyError } from "@/lib/passkey-errors";
import { describeStepUp } from "./security-keys-card";

interface PasskeyInfo {
  id: string;
  name: string;
  credentialDeviceType: string;
  credentialBackedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

type ReauthMethod = "password" | "passkey" | "totp" | "webauthn";

type ExistingFactorProof =
  | { method: "password"; password: string }
  | { method: "totp"; code: string }
  | {
      method: "passkey" | "webauthn";
      challengeId: string;
      credential: unknown;
    };

/**
 * Primary-passkey management: list (name, device, backup, created, last used),
 * add (registration ceremony), rename, and delete. The passwordless-primary
 * passkey home — distinct from the second-factor security keys above.
 */
export function PasskeyListSection({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [reauthOpen, setReauthOpen] = useState(false);
  const [reauthMethod, setReauthMethod] = useState<ReauthMethod>("password");
  const [reauthSecret, setReauthSecret] = useState("");

  const { data: passkeys } = useQuery({
    queryKey: queryKeys.passkeys(),
    queryFn: async () => apiGet<PasskeyInfo[]>("/api/auth/passkeys"),
    enabled: isAuthenticated,
  });

  const add = useMutation({
    mutationFn: async ({
      method,
      secret,
    }: {
      method: ReauthMethod;
      secret: string;
    }) => {
      const webauthn = await import("@simplewebauthn/browser");
      let freshFactor: ExistingFactorProof;

      if (method === "password") {
        freshFactor = { method, password: secret };
      } else if (method === "totp") {
        freshFactor = { method, code: secret };
      } else {
        const assertionChallenge = await apiPost<{
          options: Parameters<
            typeof webauthn.startAuthentication
          >[0]["optionsJSON"];
          challengeId: string;
        }>("/api/auth/passkey/register-options", { method });
        const credential = await webauthn.startAuthentication({
          optionsJSON: assertionChallenge.options,
        });
        freshFactor = {
          method,
          challengeId: assertionChallenge.challengeId,
          credential,
        };
      }

      const { options, challengeId } = await apiPost<{
        options: Parameters<
          typeof webauthn.startRegistration
        >[0]["optionsJSON"];
        challengeId: string;
      }>("/api/auth/passkey/register-options", freshFactor);
      const credential = await webauthn.startRegistration({
        optionsJSON: options,
      });
      await apiPost("/api/auth/passkey/register-verify", {
        challengeId,
        credential,
      });
    },
    onSuccess: () => {
      setMsg(null);
      setReauthOpen(false);
      setReauthSecret("");
      setReauthMethod("password");
      queryClient.invalidateQueries({ queryKey: queryKeys.passkeys() });
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setMsg(err.message || t("settings.passkeyRegistrationFailed"));
      } else {
        const { key, params } = describePasskeyError(err);
        setMsg(t(key, params));
      }
    },
  });

  const rename = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      await apiPatch(`/api/auth/passkeys/${id}`, { name });
    },
    onSuccess: () => {
      setEditingId(null);
      setMsg(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.passkeys() });
    },
    onError: (err: Error) => setMsg(err.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await apiDelete(`/api/auth/passkeys/${id}`);
    },
    onSuccess: () => {
      setMsg(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.passkeys() });
    },
    // Removal is step-up gated. The server's own prose says "second-factor",
    // which is wrong for the passkey-only account this card mostly serves — the
    // credential to re-prove is the passkey — so the refusal gets its own
    // sentence naming the recovery that exists on the web: sign in again.
    onError: (err: Error) =>
      setMsg(
        describeStepUp(err, err.message, t("settings.passkeyStepUpRequired")),
      ),
  });

  const DEVICE_TYPE_LABELS: Record<string, string> = {
    singleDevice: t("settings.singleDevice"),
    multiDevice: t("settings.multiDevice"),
  };

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={Fingerprint}
        title={t("settings.passkeys")}
        description={t("settings.passkeysDescription")}
      />

      <div>
        {!passkeys || passkeys.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("settings.noPasskeys")}
          </p>
        ) : (
          <ul className="space-y-2" data-testid="passkeys-list">
            {passkeys.map((pk) => (
              <SettingsCard as="li" key={pk.id}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    {editingId === pk.id ? (
                      <form
                        className="flex items-center gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          rename.mutate({ id: pk.id, name: editName.trim() });
                        }}
                      >
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          maxLength={64}
                          aria-label={t("settings.passkeyName")}
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
                          {pk.name}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                          <Badge variant="outline" className="text-xs">
                            {DEVICE_TYPE_LABELS[pk.credentialDeviceType] ??
                              pk.credentialDeviceType}
                          </Badge>
                          <Badge
                            variant={
                              pk.credentialBackedUp ? "secondary" : "outline"
                            }
                            className="text-xs"
                          >
                            {pk.credentialBackedUp
                              ? t("settings.backedUp")
                              : t("common.no")}
                          </Badge>
                          <span className="text-muted-foreground">
                            {pk.lastUsedAt
                              ? t("settings.security.keys.lastUsed", {
                                  date: formatDate(pk.lastUsedAt),
                                })
                              : t("settings.security.keys.neverUsed")}
                          </span>
                        </div>
                      </>
                    )}
                  </div>

                  {editingId !== pk.id && (
                    <div className="flex shrink-0 gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="min-h-11 min-w-11 sm:h-8 sm:min-h-0 sm:w-8 sm:min-w-0"
                        onClick={() => {
                          setEditingId(pk.id);
                          setEditName(pk.name);
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
                            aria-label={t("settings.deletePasskey")}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              {t("settings.deletePasskey")}
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              {t("settings.deletePasskeyDescription")}
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
                              onClick={() => remove.mutate(pk.id)}
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

        <AlertDialog
          open={reauthOpen}
          onOpenChange={(open) => {
            if (add.isPending) return;
            setReauthOpen(open);
            if (open) setMsg(null);
          }}
        >
          <div className="mt-4">
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 sm:min-h-9"
                disabled={add.isPending}
              >
                {add.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                ) : (
                  <KeyRound className="h-4 w-4" />
                )}
                {t("settings.addPasskey")}
              </Button>
            </AlertDialogTrigger>
          </div>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("settings.passkeyReauth.title")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("settings.passkeyReauth.description")}
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div
              className="grid grid-cols-2 gap-2"
              role="group"
              aria-label={t("settings.passkeyReauth.methodLabel")}
            >
              {(
                [
                  ["password", t("settings.passkeyReauth.methods.password")],
                  ["totp", t("settings.passkeyReauth.methods.totp")],
                  ["passkey", t("settings.passkeyReauth.methods.passkey")],
                  ["webauthn", t("settings.passkeyReauth.methods.webauthn")],
                ] satisfies Array<[ReauthMethod, string]>
              ).map(([method, label]) => (
                <Button
                  key={method}
                  type="button"
                  variant={reauthMethod === method ? "secondary" : "outline"}
                  aria-pressed={reauthMethod === method}
                  disabled={
                    add.isPending ||
                    (method === "passkey" && (passkeys?.length ?? 0) === 0)
                  }
                  onClick={() => {
                    setReauthMethod(method);
                    setReauthSecret("");
                    setMsg(null);
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>

            {reauthMethod === "password" && (
              <Input
                type="password"
                autoComplete="current-password"
                value={reauthSecret}
                onChange={(event) => setReauthSecret(event.target.value)}
                placeholder={t("settings.passkeyReauth.currentPassword")}
                aria-label={t("settings.passkeyReauth.currentPassword")}
                autoFocus
              />
            )}
            {reauthMethod === "totp" && (
              <Input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={reauthSecret}
                onChange={(event) =>
                  setReauthSecret(event.target.value.replace(/\D/g, ""))
                }
                placeholder={t(
                  "settings.passkeyReauth.authenticatorPlaceholder",
                )}
                aria-label={t("settings.passkeyReauth.authenticatorCode")}
                autoFocus
              />
            )}

            {msg && (
              <div
                role="alert"
                className="text-destructive flex items-center gap-2 text-sm"
              >
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {msg}
              </div>
            )}

            <AlertDialogFooter>
              <AlertDialogCancel disabled={add.isPending}>
                {t("common.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={
                  add.isPending ||
                  ((reauthMethod === "password" || reauthMethod === "totp") &&
                    reauthSecret.length === 0)
                }
                aria-busy={add.isPending || undefined}
                onClick={(event) => {
                  event.preventDefault();
                  add.mutate({
                    method: reauthMethod,
                    secret: reauthSecret,
                  });
                }}
              >
                {add.isPending && (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                )}
                {t("settings.passkeyReauth.verifyAndAdd")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {msg && !reauthOpen && (
          <div
            role="alert"
            className="text-destructive mt-3 flex items-center gap-2 text-sm"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {msg}
          </div>
        )}
      </div>
    </SettingsCard>
  );
}

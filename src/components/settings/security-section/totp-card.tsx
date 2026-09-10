"use client";

import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  Loader2,
  Smartphone,
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
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { ApiError, apiPost } from "@/lib/api/api-fetch";
import { RecoveryCodesPanel } from "./recovery-codes-panel";

interface SetupData {
  otpauthUri: string;
  totpSecret: string;
}

interface ConfirmResult {
  enabled: boolean;
  recoveryCodes: string[];
  recoveryCodesRemaining: number;
}

/**
 * Map a step-up 401 to a clear re-login message; otherwise the raw message.
 *
 * Exported for the unit suite: this is the sentence a refused mutation leaves
 * on the card, and the card is where a person reads it.
 */
export function describeError(
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

export function TotpCard({
  enabled,
  recoveryCodesRemaining,
}: {
  enabled: boolean;
  recoveryCodesRemaining: number;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const codeFieldId = useId();
  const disableCodeId = useId();

  const [setup, setSetup] = useState<SetupData | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [secretCopied, setSecretCopied] = useState(false);
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [disableCode, setDisableCode] = useState("");
  const [disableMethod, setDisableMethod] = useState<"totp" | "recovery">(
    "totp",
  );

  // Both confirmations are controlled rather than left to Radix.
  //
  // The confirming click has to `preventDefault()` — that is what keeps the
  // dialog up, and the button disabled, while the request is in flight. But
  // suppressing the close means nothing closes it afterwards either, and on a
  // REFUSAL the branch below survives the answer: the dialog stayed open over
  // a card whose message the overlay covered, with the confirm button live
  // again, so the same refusal could be re-triggered forever with no way to
  // read why. On success it went unnoticed only because the fresh-codes panel
  // replaces this branch and the dialog unmounts with it.
  //
  // So each mutation puts its own dialog down when the request settles,
  // whatever the answer was, and the message lands on an uncovered card.
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);

  function resetWizard() {
    setSetup(null);
    setQrDataUrl(null);
    setCode("");
    setSecretCopied(false);
    setError(null);
  }

  const beginSetup = useMutation({
    mutationFn: async () => {
      return apiPost<SetupData>("/api/auth/me/mfa/totp/setup");
    },
    onSuccess: async (data) => {
      setError(null);
      setSetup(data);
      try {
        const QRCode = (await import("qrcode")).default;
        setQrDataUrl(await QRCode.toDataURL(data.otpauthUri, { margin: 1 }));
      } catch {
        // QR render is best-effort — the manual secret below is the fallback.
        setQrDataUrl(null);
      }
    },
    onError: (err) =>
      setError(
        describeError(
          err,
          t("settings.security.totp.setupFailed"),
          t("settings.security.stepUpRequired"),
        ),
      ),
  });

  const confirm = useMutation({
    mutationFn: async () => {
      return apiPost<ConfirmResult>("/api/auth/me/mfa/totp/confirm", { code });
    },
    onSuccess: (data) => {
      setError(null);
      setFreshCodes(data.recoveryCodes);
      resetWizard();
      queryClient.invalidateQueries({ queryKey: queryKeys.mfaStatus() });
    },
    onError: (err) =>
      setError(
        describeError(
          err,
          t("settings.security.totp.invalidCode"),
          t("settings.security.stepUpRequired"),
        ),
      ),
  });

  const disable = useMutation({
    mutationFn: async () => {
      await apiPost("/api/auth/me/mfa/disable", {
        code: disableCode,
        method: disableMethod,
      });
    },
    onSuccess: () => {
      setDisableCode("");
      setFreshCodes(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.mfaStatus() });
    },
    onError: (err) =>
      setError(
        describeError(
          err,
          t("settings.security.totp.disableFailed"),
          t("settings.security.stepUpRequired"),
        ),
      ),
    onSettled: () => setDisableOpen(false),
  });

  const regenerate = useMutation({
    mutationFn: async () => {
      return apiPost<{ recoveryCodes: string[] }>(
        "/api/auth/me/mfa/recovery-codes/regenerate",
      );
    },
    onSuccess: (data) => {
      setError(null);
      setFreshCodes(data.recoveryCodes);
      queryClient.invalidateQueries({ queryKey: queryKeys.mfaStatus() });
    },
    onError: (err) =>
      setError(
        describeError(
          err,
          t("settings.security.recovery.regenFailed"),
          t("settings.security.stepUpRequired"),
        ),
      ),
    onSettled: () => setRegenerateOpen(false),
  });

  async function copySecret() {
    if (!setup) return;
    try {
      await navigator.clipboard.writeText(setup.totpSecret);
      setSecretCopied(true);
      setTimeout(() => setSecretCopied(false), 2000);
    } catch {
      /* clipboard blocked — the secret stays visible for manual entry */
    }
  }

  return (
    <SettingsCard data-testid="totp-card">
      <SettingsCardHeader
        icon={Smartphone}
        title={t("settings.security.totp.title")}
        description={t("settings.security.totp.description")}
        status={
          enabled ? (
            <Badge variant="secondary">{t("settings.security.active")}</Badge>
          ) : (
            <Badge variant="outline">{t("settings.security.inactive")}</Badge>
          )
        }
      />

      <div>
        {/* ── Not enabled, no wizard: the enable CTA ── */}
        {!enabled && !setup && !freshCodes && (
          <Button
            type="button"
            data-testid="totp-setup-start"
            className="min-h-11 sm:min-h-9"
            onClick={() => beginSetup.mutate()}
            disabled={beginSetup.isPending}
          >
            {beginSetup.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <KeyRound className="h-4 w-4" />
            )}
            {t("settings.security.totp.setUp")}
          </Button>
        )}

        {/* ── Enable wizard ── */}
        {setup && (
          <div className="space-y-4">
            <ol className="text-muted-foreground list-decimal space-y-3 pl-6 text-sm">
              <li>{t("settings.security.totp.step1")}</li>
              <li>{t("settings.security.totp.step2")}</li>
            </ol>

            <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
              {qrDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={qrDataUrl}
                  alt={t("settings.security.totp.qrAlt")}
                  width={176}
                  height={176}
                  className="border-border rounded-lg border bg-white p-2"
                />
              ) : (
                <div className="border-border text-muted-foreground flex h-44 w-44 items-center justify-center rounded-lg border text-xs">
                  {t("settings.security.totp.qrUnavailable")}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium">
                  {t("settings.security.totp.manualEntry")}
                </p>
                <div className="mt-1 flex items-center gap-2">
                  <code className="border-border bg-muted/40 min-w-0 flex-1 truncate rounded border px-2 py-1.5 font-mono text-xs">
                    {setup.totpSecret}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="min-h-11 min-w-11 shrink-0 sm:h-8 sm:min-h-0 sm:w-8 sm:min-w-0"
                    onClick={copySecret}
                    aria-label={t("common.copy")}
                  >
                    {secretCopied ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              </div>
            </div>

            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                confirm.mutate();
              }}
            >
              <Label htmlFor={codeFieldId}>
                {t("settings.security.totp.enterCode")}
              </Label>
              <div className="flex gap-2">
                <Input
                  id={codeFieldId}
                  data-testid="totp-confirm-code"
                  value={code}
                  onChange={(e) =>
                    setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  className="font-mono tracking-widest"
                  aria-invalid={!!error || undefined}
                />
                <Button
                  type="submit"
                  data-testid="totp-confirm-submit"
                  className="min-h-11 sm:min-h-9"
                  disabled={confirm.isPending || code.length !== 6}
                >
                  {confirm.isPending && (
                    <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                  )}
                  {t("settings.security.totp.verify")}
                </Button>
              </div>
              <button
                type="button"
                onClick={resetWizard}
                className="text-muted-foreground hover:text-foreground text-xs"
              >
                {t("common.cancel")}
              </button>
            </form>
          </div>
        )}

        {/* ── Fresh recovery codes (post-confirm or post-regen) ── */}
        {freshCodes && (
          <div className="space-y-3">
            <RecoveryCodesPanel codes={freshCodes} />
            <SettingsCardActions>
              <Button
                type="button"
                data-testid="recovery-codes-dismiss"
                variant="outline"
                className="min-h-11 sm:min-h-9"
                onClick={() => setFreshCodes(null)}
              >
                {t("settings.security.recovery.savedIt")}
              </Button>
            </SettingsCardActions>
          </div>
        )}

        {/* ── Enabled, idle: recovery status + disable/regen actions ── */}
        {enabled && !freshCodes && (
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">
              {t(
                recoveryCodesRemaining === 1
                  ? "settings.security.recovery.remainingOne"
                  : "settings.security.recovery.remainingOther",
                { count: recoveryCodesRemaining },
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <AlertDialog
                open={regenerateOpen}
                onOpenChange={setRegenerateOpen}
              >
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    data-testid="recovery-regenerate"
                    variant="outline"
                    className="min-h-11 sm:min-h-9"
                    disabled={regenerate.isPending}
                  >
                    {regenerate.isPending && (
                      <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                    )}
                    {t("settings.security.recovery.regenerate")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent data-testid="recovery-regenerate-dialog">
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.security.recovery.regenerateTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.security.recovery.regenerateConfirm")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      data-testid="recovery-regenerate-confirm"
                      disabled={regenerate.isPending}
                      aria-busy={regenerate.isPending || undefined}
                      onClick={(e) => {
                        e.preventDefault();
                        regenerate.mutate();
                      }}
                    >
                      {regenerate.isPending && (
                        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                      )}
                      {t("settings.security.recovery.regenerate")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>

              <AlertDialog open={disableOpen} onOpenChange={setDisableOpen}>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    className="text-destructive min-h-11 sm:min-h-9"
                  >
                    {t("settings.security.totp.disable")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent data-testid="totp-disable-dialog">
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.security.totp.disableTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.security.totp.disableConfirm")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <div className="space-y-2">
                    <Label htmlFor={disableCodeId}>
                      {t("settings.security.totp.currentCode")}
                    </Label>
                    <Input
                      id={disableCodeId}
                      value={disableCode}
                      onChange={(e) =>
                        setDisableCode(
                          disableMethod === "totp"
                            ? e.target.value.replace(/\D/g, "").slice(0, 6)
                            : e.target.value,
                        )
                      }
                      inputMode={disableMethod === "totp" ? "numeric" : "text"}
                      autoComplete="one-time-code"
                      placeholder={
                        disableMethod === "totp" ? "123456" : "XXXXX-XXXXX"
                      }
                      className="font-mono"
                    />
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground text-xs"
                      onClick={() =>
                        setDisableMethod((m) =>
                          m === "totp" ? "recovery" : "totp",
                        )
                      }
                    >
                      {disableMethod === "totp"
                        ? t("settings.security.useRecoveryCode")
                        : t("settings.security.useAuthenticator")}
                    </button>
                  </div>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      disabled={
                        disable.isPending ||
                        (disableMethod === "totp"
                          ? disableCode.length !== 6
                          : disableCode.length < 6)
                      }
                      aria-busy={disable.isPending || undefined}
                      onClick={(e) => {
                        e.preventDefault();
                        disable.mutate();
                      }}
                    >
                      {disable.isPending && (
                        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                      )}
                      {t("settings.security.totp.disable")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        )}

        {error && (
          <div
            role="alert"
            data-testid="totp-error"
            className="text-destructive mt-3 flex items-center gap-2 text-sm"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}
      </div>
    </SettingsCard>
  );
}

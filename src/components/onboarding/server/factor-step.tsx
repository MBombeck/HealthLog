"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Fingerprint, Smartphone } from "lucide-react";

import { ChoiceChip } from "@/components/onboarding/choice-chip";
import { StepActions } from "@/components/onboarding/step-actions";
import { StepHeading } from "@/components/onboarding/step-heading";
import { addPasskey } from "@/components/settings/security-section/passkey-list-section";
import { RecoveryCodesPanel } from "@/components/settings/security-section/recovery-codes-panel";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { useAuth } from "@/hooks/use-auth";
import { ApiError, apiPost } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { describePasskeyError } from "@/lib/passkey-errors";
import { queryKeys } from "@/lib/query-keys";

import { useServerStep } from "./use-server-step";

type Factor = "passkey" | "totp";

type Phase =
  | { kind: "choose" }
  | { kind: "code"; qr: string | null; secret: string }
  | { kind: "codes"; codes: string[] };

/**
 * The owner's second factor, right after the account (1.50). A passkey
 * counts as the second factor on its own; an authenticator app shows its QR
 * code and secret here and is confirmed with one code, after which the
 * recovery codes are shown once. Both ask for the password just set, the
 * proof the enrolment routes take.
 *
 * "Later" is allowed until the policy's date, which the sentence names. The
 * deadline banner then waits until the last days before it (it waits only
 * for this answer, never for an inferred one).
 */
export function FactorStep() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const step = useServerStep("account-mfa");
  const [factor, setFactor] = useState<Factor>("passkey");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "choose" });
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const enrollment = user?.mfaEnrollment;
  const dueAt =
    enrollment?.state === "grace" && enrollment.dueAt
      ? fmt.date(new Date(enrollment.dueAt))
      : null;

  function describe(err: unknown, fallback: string): string {
    if (err instanceof ApiError) return localizedApiError(err, t, fallback);
    const { key, params } = describePasskeyError(err);
    return t(key, params);
  }

  async function addFactor() {
    setWorking(true);
    setError(null);
    try {
      if (factor === "passkey") {
        await addPasskey("password", password);
        await queryClient.invalidateQueries({ queryKey: queryKeys.passkeys() });
        await queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
        await step.record("done");
        return;
      }
      const setup = await apiPost<{ otpauthUri: string; totpSecret: string }>(
        "/api/auth/me/mfa/totp/setup",
        { method: "password", password },
      );
      let qr: string | null = null;
      try {
        const QRCode = (await import("qrcode")).default;
        qr = await QRCode.toDataURL(setup.otpauthUri, { margin: 1 });
      } catch {
        // Best-effort: the secret below is the fallback.
      }
      setPhase({ kind: "code", qr, secret: setup.totpSecret });
      setWorking(false);
    } catch (err) {
      setWorking(false);
      setError(describe(err, "settings.passkeyRegistrationFailed"));
    }
  }

  async function confirmCode() {
    setWorking(true);
    setError(null);
    try {
      const result = await apiPost<{ recoveryCodes: string[] }>(
        "/api/auth/me/mfa/totp/confirm",
        { code: code.trim() },
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.mfaStatus() });
      await queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
      setPhase({ kind: "codes", codes: result.recoveryCodes });
      setWorking(false);
    } catch (err) {
      setWorking(false);
      setError(describe(err, "settings.security.totp.invalidCode"));
    }
  }

  async function later() {
    if (working) return;
    setWorking(true);
    try {
      await step.record("skipped");
    } catch (err) {
      setWorking(false);
      step.fail(err);
    }
  }

  async function finish() {
    setWorking(true);
    try {
      await step.record("done");
    } catch (err) {
      setWorking(false);
      step.fail(err);
    }
  }

  const passwordField = (
    <div className="space-y-2">
      <Label htmlFor="server-setup-factor-password" noColon>
        {t("setup.server.factor.password")}
      </Label>
      <PasswordInput
        id="server-setup-factor-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
      />
    </div>
  );

  return (
    <section
      aria-labelledby="server-setup-factor-title"
      className="flex flex-1 flex-col"
      data-slot="server-setup-step"
      data-step="account-mfa"
    >
      <StepHeading
        id="server-setup-factor-title"
        title={t("setup.server.factor.title")}
        description={
          dueAt
            ? t("setup.server.factor.due", { date: dueAt })
            : t("setup.server.factor.body")
        }
        tone="foreground"
      />

      {phase.kind === "choose" ? (
        <fieldset className="grid gap-2">
          <legend className="sr-only">{t("setup.server.factor.title")}</legend>
          <ChoiceChip
            name="server-setup-factor"
            value="passkey"
            kind="single"
            checked={factor === "passkey"}
            onChange={() => setFactor("passkey")}
            label={t("setup.server.factor.passkey")}
            hint={t("setup.server.factor.passkeyHint")}
            Icon={Fingerprint}
          >
            {passwordField}
          </ChoiceChip>
          <ChoiceChip
            name="server-setup-factor"
            value="totp"
            kind="single"
            checked={factor === "totp"}
            onChange={() => setFactor("totp")}
            label={t("setup.server.factor.totp")}
            hint={t("setup.server.factor.totpHint")}
            Icon={Smartphone}
          >
            {passwordField}
          </ChoiceChip>
        </fieldset>
      ) : phase.kind === "code" ? (
        <TotpCode
          qr={phase.qr}
          secret={phase.secret}
          code={code}
          onCode={setCode}
        />
      ) : (
        <RecoveryCodesPanel codes={phase.codes} />
      )}

      {error ? (
        <p
          role="alert"
          className="text-destructive mt-4 text-sm"
          data-slot="server-setup-factor-error"
        >
          {error}
        </p>
      ) : null}

      <FactorActions
        phase={phase.kind}
        factor={factor}
        ready={
          phase.kind === "code" ? code.trim().length >= 6 : password.length > 0
        }
        pending={working}
        onLater={() => void later()}
        onAdd={() => void addFactor()}
        onConfirm={() => void confirmCode()}
        onFinish={() => void finish()}
      />
    </section>
  );
}

/** The authenticator app's QR code and secret, and the one code that confirms it. */
function TotpCode({
  qr,
  secret,
  code,
  onCode,
}: {
  qr: string | null;
  secret: string;
  code: string;
  onCode: (next: string) => void;
}) {
  const { t } = useTranslations();
  return (
    <div className="space-y-4" data-slot="server-setup-factor-totp">
      <div className="flex items-center gap-4">
        {qr ? (
          // eslint-disable-next-line @next/next/no-img-element -- a data: URL
          <img
            src={qr}
            alt={t("settings.security.totp.qrAlt")}
            width={128}
            height={128}
            className="size-32 shrink-0 rounded-md bg-white"
          />
        ) : null}
        <div className="min-w-0 space-y-1 text-sm">
          <p>{t("setup.server.factor.scan")}</p>
          <p className="text-muted-foreground font-mono text-xs break-all">
            {secret}
          </p>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="server-setup-factor-code" noColon>
          {t("setup.server.factor.code")}
        </Label>
        <Input
          id="server-setup-factor-code"
          value={code}
          onChange={(e) => onCode(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={8}
        />
      </div>
    </div>
  );
}

/** The step's action pair for each part: choose, confirm the code, go on. */
function FactorActions({
  phase,
  factor,
  ready,
  pending,
  onLater,
  onAdd,
  onConfirm,
  onFinish,
}: {
  phase: Phase["kind"];
  factor: Factor;
  ready: boolean;
  pending: boolean;
  onLater: () => void;
  onAdd: () => void;
  onConfirm: () => void;
  onFinish: () => void;
}) {
  const { t } = useTranslations();
  if (phase === "codes") {
    return (
      <StepActions
        primary={{ label: t("onboarding.shell.next"), onClick: onFinish }}
        pending={pending}
      />
    );
  }
  return (
    <StepActions
      secondary={{ label: t("setup.later"), onClick: onLater }}
      primary={
        phase === "choose"
          ? {
              label: t(
                factor === "passkey"
                  ? "setup.server.factor.addPasskey"
                  : "setup.server.factor.addTotp",
              ),
              onClick: onAdd,
              disabled: !ready,
            }
          : {
              label: t("setup.server.factor.confirm"),
              onClick: onConfirm,
              disabled: !ready,
            }
      }
      pending={pending}
    />
  );
}

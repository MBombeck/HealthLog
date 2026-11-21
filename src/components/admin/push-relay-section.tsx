"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { showErrorToast } from "@/lib/errors/error-toast";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { SettingsToggle } from "./_shared";
import { usePushRelayStatus, useSetPushRelay } from "./use-push-relay";
import { PushRelayTools } from "./push-relay-tools";

const STATE_LABEL = {
  ok: "admin.pushRelay.state.ok",
  degraded: "admin.pushRelay.state.degraded",
  down: "admin.pushRelay.state.down",
  off: "admin.pushRelay.state.off",
} as const;

/**
 * Registration refusals the admin can act on, by the `reason` the server
 * reports. Any other reason stays with the state badge.
 */
const REASON_LABEL = new Map<
  string,
  | "admin.pushRelay.reason.inviteRequired"
  | "admin.pushRelay.reason.inviteRejected"
  | "admin.pushRelay.reason.registrationPaused"
>([
  ["invite_required", "admin.pushRelay.reason.inviteRequired"],
  ["invite_rejected", "admin.pushRelay.reason.inviteRejected"],
  ["registration_paused", "admin.pushRelay.reason.registrationPaused"],
]);

/** The reasons an invite code moves on. */
const INVITE_REASONS = new Set(["invite_required", "invite_rejected"]);

/** The relay's one-time invite code: 24 base64url characters. */
const INVITE_PATTERN = /^[A-Za-z0-9_-]{24}$/;

const UNAVAILABLE_LABEL = {
  mode_off: "admin.pushRelay.unavailable.modeOff",
  invalid_url: "admin.pushRelay.unavailable.invalidUrl",
  keys_unpinned: "admin.pushRelay.unavailable.keysUnpinned",
} as const;

/** The relay card when its status could not be read. */
function PushRelayLoadError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const { t } = useTranslations();
  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={Send}
        title={t("admin.pushRelay.title")}
        description={t("admin.pushRelay.description")}
      />
      <QueryErrorRow
        inset
        error={error}
        message={t("admin.pushRelay.loadError")}
        onRetry={onRetry}
      />
    </SettingsCard>
  );
}

/**
 * The operator's switch for the push relay: off until turned on, and turning
 * it on asks for the relay terms and the household confirmation.
 */
export function PushRelaySection() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const statusQuery = usePushRelayStatus();
  const status = statusQuery.data;
  const setRelay = useSetPushRelay();
  const [enableOpen, setEnableOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  // A fresh dialog, with nothing ticked or entered, each time it opens.
  const [enableKey, setEnableKey] = useState(0);

  // A failed read says so; hidden is only for a server whose operator
  // turned the relay off (`allowed: false`).
  if (statusQuery.isError && !status) {
    return (
      <PushRelayLoadError
        error={statusQuery.error}
        onRetry={() => void statusQuery.refetch()}
      />
    );
  }
  if (!status || !status.allowed) return null;

  const reasonKey =
    status.offered && !status.instanceId && status.reason
      ? REASON_LABEL.get(status.reason)
      : undefined;

  function openEnable() {
    setEnableKey((key) => key + 1);
    setEnableOpen(true);
  }

  function save(body: Parameters<typeof setRelay.mutate>[0]) {
    setRelay.mutate(body, {
      // The switch took when the server now says what was asked for; on
      // but not yet registered at the relay is a partial result, and a
      // refusal the admin can act on says why.
      onSuccess: (next) => {
        const refusal =
          next.offered && !next.instanceId && next.reason
            ? REASON_LABEL.get(next.reason)
            : undefined;
        toastWrittenOutcome(
          next.offered !== body.enabled
            ? "failed"
            : next.offered && !next.instanceId
              ? "partial"
              : "success",
          t(
            refusal ??
              (next.offered
                ? "admin.pushRelay.enabled"
                : "admin.pushRelay.disabled"),
          ),
        );
      },
      onError: (failure) =>
        showErrorToast(t("admin.pushRelay.saveFailed"), { cause: failure }),
    });
  }

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={Send}
        title={t("admin.pushRelay.title")}
        description={t("admin.pushRelay.description")}
        status={
          status.offered ? (
            <Badge
              variant={status.state === "down" ? "destructive" : "secondary"}
            >
              {t(STATE_LABEL[status.state])}
            </Badge>
          ) : undefined
        }
      />
      <div className="space-y-3">
        <p className="text-sm">{t("admin.pushRelay.whatItSees")}</p>
        {!status.available && status.unavailableReason && (
          <p className="text-muted-foreground text-xs">
            {t(UNAVAILABLE_LABEL[status.unavailableReason])}
          </p>
        )}
        <SettingsToggle
          label={t("admin.pushRelay.toggleLabel")}
          description={t("admin.pushRelay.toggleDescription")}
          checked={status.offered}
          onCheckedChange={(checked) => {
            if (checked) {
              openEnable();
            } else {
              setDisableOpen(true);
            }
          }}
          disabled={
            setRelay.isPending || (!status.available && !status.offered)
          }
        />
        {status.offered && (
          <p className="text-muted-foreground text-xs">
            {t("admin.pushRelay.devices", { count: status.devices.bound })}
            {status.since
              ? `, ${t("admin.pushRelay.since", {
                  time: fmt.dateTime(status.since),
                })}`
              : ""}
          </p>
        )}
        {reasonKey && (
          <div className="space-y-2" data-slot="push-relay-refusal">
            <p className="text-sm">{t(reasonKey)}</p>
            {status.reason && INVITE_REASONS.has(status.reason) && (
              <Button
                size="sm"
                variant="outline"
                onClick={openEnable}
                disabled={setRelay.isPending || !status.available}
              >
                {t("admin.pushRelay.invite.enter")}
              </Button>
            )}
          </div>
        )}
        {status.offered && <PushRelayTools registered={!!status.instanceId} />}
        <p className="text-muted-foreground flex flex-wrap gap-3 text-xs">
          <a
            className="underline"
            href={status.docsUrl}
            target="_blank"
            rel="noreferrer"
          >
            {t("admin.pushRelay.docs")}
          </a>
          {status.privacyUrl && (
            <a
              className="underline"
              href={status.privacyUrl}
              target="_blank"
              rel="noreferrer"
            >
              {t("admin.pushRelay.privacy")}
            </a>
          )}
          {status.termsUrl && (
            <a
              className="underline"
              href={status.termsUrl}
              target="_blank"
              rel="noreferrer"
            >
              {t("admin.pushRelay.terms")}
            </a>
          )}
        </p>
      </div>

      <PushRelayEnableDialog
        key={enableKey}
        open={enableOpen}
        onOpenChange={setEnableOpen}
        onConfirm={save}
      />

      <AlertDialog open={disableOpen} onOpenChange={setDisableOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("admin.pushRelay.disableTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("admin.pushRelay.disableBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("admin.pushRelay.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => save({ enabled: false })}>
              {t("admin.pushRelay.disable")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  );
}

type SwitchBody = Parameters<ReturnType<typeof useSetPushRelay>["mutate"]>[0];

/**
 * Turning the relay on: the two confirmations, and the relay's invite code
 * for a relay that accepts new servers by invitation only.
 */
function PushRelayEnableDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (body: SwitchBody) => void;
}) {
  const { t } = useTranslations();
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [householdOnly, setHouseholdOnly] = useState(false);
  const [invite, setInvite] = useState("");
  const inviteTrimmed = invite.trim();
  const inviteInvalid =
    inviteTrimmed !== "" && !INVITE_PATTERN.test(inviteTrimmed);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("admin.pushRelay.dialogTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("admin.pushRelay.dialogBody")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              data-slot="push-relay-accept-terms"
              checked={acceptTerms}
              onCheckedChange={(next) => setAcceptTerms(next === true)}
              className="mt-0.5"
            />
            <span>{t("admin.pushRelay.acceptTerms")}</span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              data-slot="push-relay-household"
              checked={householdOnly}
              onCheckedChange={(next) => setHouseholdOnly(next === true)}
              className="mt-0.5"
            />
            <span>{t("admin.pushRelay.householdOnly")}</span>
          </label>
          <div className="space-y-1">
            <Label htmlFor="push-relay-invite">
              {t("admin.pushRelay.invite.label")}
            </Label>
            <Input
              id="push-relay-invite"
              data-slot="push-relay-invite"
              value={invite}
              onChange={(event) => setInvite(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              aria-invalid={inviteInvalid || undefined}
              aria-describedby="push-relay-invite-hint"
            />
            <p
              id="push-relay-invite-hint"
              className="text-muted-foreground text-xs"
            >
              {t(
                inviteInvalid
                  ? "admin.pushRelay.invite.invalid"
                  : "admin.pushRelay.invite.hint",
              )}
            </p>
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("admin.pushRelay.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={!acceptTerms || !householdOnly || inviteInvalid}
            onClick={() =>
              onConfirm({
                enabled: true,
                acceptTerms: true,
                householdOnly: true,
                ...(inviteTrimmed ? { invite: inviteTrimmed } : {}),
              })
            }
          >
            {t("admin.pushRelay.enable")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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

const UNAVAILABLE_LABEL = {
  mode_off: "admin.pushRelay.unavailable.modeOff",
  invalid_url: "admin.pushRelay.unavailable.invalidUrl",
  keys_unpinned: "admin.pushRelay.unavailable.keysUnpinned",
} as const;

/**
 * The operator's switch for the push relay: off until turned on, and turning
 * it on asks for the relay terms and the household confirmation.
 */
export function PushRelaySection() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { data: status } = usePushRelayStatus();
  const setRelay = useSetPushRelay();
  const [enableOpen, setEnableOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [householdOnly, setHouseholdOnly] = useState(false);

  if (!status || !status.allowed) return null;

  function save(body: Parameters<typeof setRelay.mutate>[0]) {
    setRelay.mutate(body, {
      // The switch took when the server now says what was asked for; on
      // but not yet registered at the relay is a partial result.
      onSuccess: (next) =>
        toastWrittenOutcome(
          next.offered !== body.enabled
            ? "failed"
            : next.offered && !next.instanceId
              ? "partial"
              : "success",
          t(
            next.offered
              ? "admin.pushRelay.enabled"
              : "admin.pushRelay.disabled",
          ),
        ),
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
              setAcceptTerms(false);
              setHouseholdOnly(false);
              setEnableOpen(true);
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

      <AlertDialog open={enableOpen} onOpenChange={setEnableOpen}>
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
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("admin.pushRelay.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={!acceptTerms || !householdOnly}
              onClick={() =>
                save({ enabled: true, acceptTerms: true, householdOnly: true })
              }
            >
              {t("admin.pushRelay.enable")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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

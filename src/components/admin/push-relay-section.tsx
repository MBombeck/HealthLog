"use client";

import { useState, type ReactNode } from "react";
import { Send } from "lucide-react";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Checkbox } from "@/components/ui/checkbox";
import { Disclosure } from "@/components/ui/disclosure";
import { InlineAction } from "@/components/ui/inline-action";
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
 * it on asks for the relay terms, the privacy notice and the household
 * confirmation, each on its own.
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
        <PushRelaySeesDetails
          privacyUrl={status.privacyUrl ?? status.docsUrl}
        />
        {!status.available && status.unavailableReason && (
          <p className="text-muted-foreground text-xs">
            {t(UNAVAILABLE_LABEL[status.unavailableReason])}
          </p>
        )}
        <SettingsToggle
          label={t("admin.pushRelay.toggleLabel")}
          description={t(
            status.offered
              ? "admin.pushRelay.toggleDescriptionOn"
              : "admin.pushRelay.toggleDescription",
          )}
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
        <p className="flex flex-wrap gap-x-4 gap-y-1">
          <RelayLink href={status.docsUrl}>
            {t("admin.pushRelay.docs")}
          </RelayLink>
          {status.privacyUrl && (
            <RelayLink href={status.privacyUrl}>
              {t("admin.pushRelay.privacy")}
            </RelayLink>
          )}
          {status.termsUrl && (
            <RelayLink href={status.termsUrl}>
              {t("admin.pushRelay.terms")}
            </RelayLink>
          )}
        </p>
      </div>
      {status.offered && <PushRelayTools registered={!!status.instanceId} />}

      <PushRelayEnableDialog
        key={enableKey}
        termsUrl={status.termsUrl}
        privacyUrl={status.privacyUrl}
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
 * What the relay sees and what it does not, one disclosure level below the
 * card's summary sentence. The list follows the relay's own privacy notice
 * (`healthlog-push`, served at the relay's privacy URL), which stays the one
 * full source and is linked at the end.
 */
function PushRelaySeesDetails({ privacyUrl }: { privacyUrl: string }) {
  const { t } = useTranslations();
  return (
    <Disclosure
      framed
      summary={t("admin.pushRelay.seesSummary")}
      data-slot="push-relay-sees"
    >
      <p className="font-medium">{t("admin.pushRelay.seesHeading")}</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>{t("admin.pushRelay.seesWhen")}</li>
        <li>{t("admin.pushRelay.seesToken")}</li>
        <li>{t("admin.pushRelay.seesAddress")}</li>
        <li>{t("admin.pushRelay.seesConsent")}</li>
      </ul>
      <p className="font-medium">{t("admin.pushRelay.notSeesHeading")}</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>{t("admin.pushRelay.notSeesContent")}</li>
      </ul>
      <p>{t("admin.pushRelay.seesTiming")}</p>
      <p>
        <RelayLink href={privacyUrl}>
          {t("admin.pushRelay.seesSource")}
        </RelayLink>
      </p>
    </Disclosure>
  );
}

/** A link to one of the relay's own documents, opened beside the console. */
function RelayLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <InlineAction asChild tone="muted">
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    </InlineAction>
  );
}

/**
 * One confirmation of the enable dialog: a checkbox, its sentence, and the
 * document the sentence is about.
 */
function ConfirmationRow({
  id,
  checked,
  onCheckedChange,
  label,
  link,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  link: { href: string; label: string } | null;
}) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <Checkbox
        id={id}
        data-slot={id}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        className="mt-0.5"
      />
      <div className="space-y-0.5">
        <Label htmlFor={id} noColon className="pl-0 leading-snug font-normal">
          {label}
        </Label>
        {link && (
          <a
            className="block text-xs underline"
            href={link.href}
            target="_blank"
            rel="noreferrer"
          >
            {link.label}
          </a>
        )}
      </div>
    </div>
  );
}

/**
 * Turning the relay on: the three confirmations, and the relay's invite code
 * for a relay that accepts new servers by invitation only.
 */
function PushRelayEnableDialog({
  termsUrl,
  privacyUrl,
  open,
  onOpenChange,
  onConfirm,
}: {
  termsUrl: string | null;
  privacyUrl: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (body: SwitchBody) => void;
}) {
  const { t } = useTranslations();
  // Two confirmations the admin gives separately: accepting the terms and
  // having read the privacy notice. Both travel as the one `acceptTerms`
  // field the relay registration has always taken.
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [readPrivacy, setReadPrivacy] = useState(false);
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
          <ConfirmationRow
            id="push-relay-accept-terms"
            checked={acceptTerms}
            onCheckedChange={setAcceptTerms}
            label={t("admin.pushRelay.acceptTerms")}
            link={
              termsUrl
                ? { href: termsUrl, label: t("admin.pushRelay.terms") }
                : null
            }
          />
          <ConfirmationRow
            id="push-relay-read-privacy"
            checked={readPrivacy}
            onCheckedChange={setReadPrivacy}
            label={t("admin.pushRelay.readPrivacy")}
            link={
              privacyUrl
                ? { href: privacyUrl, label: t("admin.pushRelay.privacy") }
                : null
            }
          />
          <ConfirmationRow
            id="push-relay-household"
            checked={householdOnly}
            onCheckedChange={setHouseholdOnly}
            label={t("admin.pushRelay.householdOnly")}
            link={null}
          />
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
            disabled={
              !acceptTerms || !readPrivacy || !householdOnly || inviteInvalid
            }
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

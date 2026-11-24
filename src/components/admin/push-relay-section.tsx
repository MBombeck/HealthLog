"use client";

import { useState, type ReactNode } from "react";
import { Send } from "lucide-react";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Disclosure } from "@/components/ui/disclosure";
import { InlineAction } from "@/components/ui/inline-action";
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
import { cn } from "@/lib/utils";
import { SettingsToggle } from "./_shared";
import {
  usePushRelayStatus,
  useSetPushRelay,
  type AdminPushRelayStatus,
} from "./use-push-relay";
import { PushRelayAlerts, PushRelayCheckLine } from "./push-relay-check";
import { PushRelayHandoff } from "./push-relay-handoff";
import { PushRelayTools } from "./push-relay-tools";
import {
  INVITE_REASONS,
  PushRelayEnableDialog,
  relayRefusalLabel,
} from "./push-relay-enable-dialog";

/** The status pill: one word per state the server resolved. */
const SUMMARY_LABEL = {
  ok: "admin.pushRelay.state.ok",
  degraded: "admin.pushRelay.state.degraded",
  down: "admin.pushRelay.state.down",
  off: "admin.pushRelay.state.off",
  own_apns_key: "admin.pushRelay.state.ownApnsKey",
  unavailable: "admin.pushRelay.state.unavailable",
} as const;

const SUMMARY_TONE: Record<AdminPushRelayStatus["summaryState"], string> = {
  ok: "border-success/30 bg-success/15 text-success",
  degraded: "border-warning/30 bg-warning/15 text-warning",
  down: "",
  off: "text-muted-foreground",
  own_apns_key: "border-info/30 bg-info/15 text-info",
  unavailable: "text-muted-foreground",
};

/**
 * The relay's state as a pill in the card header, a dot and one word, from
 * `summaryState` as the server resolved it (the integration cards' badge).
 */
export function PushRelayStatusPill({
  state,
}: {
  state: AdminPushRelayStatus["summaryState"];
}) {
  const { t } = useTranslations();
  return (
    <Badge
      data-slot="push-relay-status"
      data-state={state}
      variant={state === "down" ? "destructive" : "outline"}
      className={cn("gap-1.5", SUMMARY_TONE[state])}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {t(SUMMARY_LABEL[state])}
    </Badge>
  );
}

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
 * confirmation, each on its own line.
 *
 * Little text by design: the state is the pill in the header, one sentence
 * says what the relay is, and everything else (what the relay sees, the
 * delivery figures, the docs) sits behind a disclosure or "Learn more". What
 * stays in view is what the admin has to act on: a refusal, a reason the
 * relay gives, changed terms, a registration left behind.
 */
export function PushRelaySection({
  besideQuestion = false,
}: {
  /**
   * Rendered beside the relay question (the server setup's notifications
   * step): while the question is open the card stays away, so the step asks
   * once instead of showing the question and the switch for the same thing.
   */
  besideQuestion?: boolean;
} = {}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const statusQuery = usePushRelayStatus();
  const status = statusQuery.data;
  const setRelay = useSetPushRelay();
  const [enableOpen, setEnableOpen] = useState(false);
  // `confirm`: the relay is on and the admin confirms a changed text.
  const [enableMode, setEnableMode] = useState<"enable" | "confirm">("enable");
  // Opened from the invite refusal: the code field shows at once.
  const [enableInvite, setEnableInvite] = useState(false);
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
  if (!status) return null;
  // Switched off by the operator, but still registered somewhere, or owing
  // the relay unbinds: say so rather than hide it.
  if (!status.allowed) return <PushRelayOffCard status={status} />;
  if (besideQuestion && status.operatorDecision === "undecided") return null;

  const reasonKey = relayRefusalLabel(status);

  function openEnable(mode: "enable" | "confirm" = "enable", invite = false) {
    setEnableMode(mode);
    setEnableInvite(invite);
    setEnableKey((key) => key + 1);
    setEnableOpen(true);
  }

  function save(body: Parameters<typeof setRelay.mutate>[0]) {
    const confirming = body.enabled && status?.offered === true;
    setRelay.mutate(body, {
      // The switch took when the server now says what was asked for; on
      // but not yet registered at the relay is a partial result, and a
      // refusal the admin can act on says why.
      onSuccess: (next) => {
        const refusal = relayRefusalLabel(next);
        toastWrittenOutcome(
          next.offered !== body.enabled
            ? "failed"
            : next.offered && !next.instanceId
              ? "partial"
              : "success",
          t(
            refusal ??
              (confirming && next.offered
                ? "admin.pushRelay.reconfirm.done"
                : next.offered
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
    <SettingsCard data-testid="push-relay-card">
      <SettingsCardHeader
        icon={Send}
        title={t("admin.pushRelay.title")}
        description={t("admin.pushRelay.description")}
        status={<PushRelayStatusPill state={status.summaryState} />}
      />
      {!status.available && status.unavailableReason && (
        <p className="text-muted-foreground text-xs">
          {t(UNAVAILABLE_LABEL[status.unavailableReason])}
        </p>
      )}
      {status.ownApnsKey && <PushRelayOwnApnsKey offered={status.offered} />}
      {/* Beside an APNs key of the server's own the relay carries nothing,
          so there is no switch to turn it on; one already on can still be
          turned off, which leaves the relay. */}
      {(!status.ownApnsKey || status.offered) && (
        <div className="space-y-1">
          <SettingsToggle
            label={t("admin.pushRelay.toggleLabel")}
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
                    time: fmt.date(status.since),
                  })}`
                : ""}
            </p>
          )}
        </div>
      )}
      {status.termsConfirmationNeeded && (
        <PushRelayReconfirm
          onOpen={() => openEnable("confirm")}
          disabled={setRelay.isPending || !status.available}
        />
      )}
      <PushRelayAlerts status={status} />
      <RelayLeftovers status={status} />
      {reasonKey && (
        <div className="space-y-2" data-slot="push-relay-refusal">
          <p className="text-sm">{t(reasonKey)}</p>
          {status.reason && INVITE_REASONS.has(status.reason) && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => openEnable("enable", true)}
              disabled={setRelay.isPending || !status.available}
            >
              {t("admin.pushRelay.invite.enter")}
            </Button>
          )}
        </div>
      )}
      <div className="space-y-2">
        <PushRelaySeesDetails
          privacyUrl={status.privacyUrl}
          termsUrl={status.termsUrl}
        />
        <PushRelayDelivery status={status} />
      </div>
      <PushRelayTools
        offered={status.offered}
        registered={!!status.instanceId}
        learnMore={
          <RelayLink href={status.docsUrl}>
            {t("admin.pushRelay.docs")}
          </RelayLink>
        }
      />

      <PushRelayEnableDialog
        key={enableKey}
        mode={enableMode}
        termsUrl={status.termsUrl}
        privacyUrl={status.privacyUrl}
        inviteOpen={enableInvite}
        open={enableOpen}
        onOpenChange={setEnableOpen}
        onConfirm={save}
      />

      <PushRelayDisableDialog
        open={disableOpen}
        onOpenChange={setDisableOpen}
        onConfirm={() => save({ enabled: false })}
      />
    </SettingsCard>
  );
}

/**
 * The relay switched off by the operator (`PUSH_RELAY_MODE=off`): hidden,
 * unless this server is still registered with a relay or owes it unbinds.
 */
function PushRelayOffCard({ status }: { status: AdminPushRelayStatus }) {
  const { t } = useTranslations();
  if (status.unreachableRegistrations.length === 0 && !status.unbindsPending) {
    return null;
  }
  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={Send}
        title={t("admin.pushRelay.title")}
        description={t("admin.pushRelay.unavailable.modeOff")}
      />
      <RelayLeftovers status={status} />
    </SettingsCard>
  );
}

/**
 * The server has an APNs key of its own and uses it: `routeFor` sends every
 * push directly to Apple, so the relay is not used while the key is set.
 * One sentence: how to use the relay instead, or, on a server that joined
 * the relay before the key, that the relay carries nothing.
 */
function PushRelayOwnApnsKey({ offered }: { offered: boolean }) {
  const { t } = useTranslations();
  return (
    <p className="text-sm" data-slot="push-relay-own-apns">
      {t(
        offered
          ? "admin.pushRelay.ownApns.registered"
          : "admin.pushRelay.ownApns.inUse",
      )}
    </p>
  );
}

/** The relay's text changed since it was turned on: confirm it once. */
function PushRelayReconfirm({
  onOpen,
  disabled,
}: {
  onOpen: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslations();
  return (
    <div className="space-y-2" data-slot="push-relay-reconfirm">
      <p className="text-sm">{t("admin.pushRelay.reconfirm.notice")}</p>
      <Button size="sm" variant="outline" onClick={onOpen} disabled={disabled}>
        {t("admin.pushRelay.reconfirm.button")}
      </Button>
    </div>
  );
}

function PushRelayDisableDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslations();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
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
          <AlertDialogAction onClick={onConfirm}>
            {t("admin.pushRelay.disable")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * What the relay sees and what it does not, behind one disclosure. The list
 * follows the relay's own privacy notice (`healthlog-push`, served at the
 * relay's privacy URL), which stays the one full source and is linked at the
 * end with the terms.
 */
function PushRelaySeesDetails({
  privacyUrl,
  termsUrl,
}: {
  privacyUrl: string | null;
  termsUrl: string | null;
}) {
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
      {(privacyUrl || termsUrl) && (
        <p className="flex flex-wrap gap-x-4 gap-y-1">
          {privacyUrl && (
            <RelayLink href={privacyUrl}>
              {t("admin.pushRelay.privacy")}
            </RelayLink>
          )}
          {termsUrl && (
            <RelayLink href={termsUrl}>{t("admin.pushRelay.terms")}</RelayLink>
          )}
        </p>
      )}
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
 * What the relay still holds of this server that the admin should know
 * about: a registration the current settings cannot reach, and unbinds the
 * relay has not confirmed.
 */
function RelayLeftovers({ status }: { status: AdminPushRelayStatus }) {
  const { t } = useTranslations();
  if (status.unreachableRegistrations.length === 0 && !status.unbindsPending) {
    return null;
  }
  return (
    <div className="space-y-1" data-slot="push-relay-leftovers">
      {status.unreachableRegistrations.map((host) => (
        <p key={host} className="text-sm">
          {t("admin.pushRelay.unreachable", { host })}
        </p>
      ))}
      {status.unbindsPending > 0 && (
        <p className="text-muted-foreground text-xs">
          {t("admin.pushRelay.unbindsPending", {
            count: status.unbindsPending,
          })}
        </p>
      )}
    </div>
  );
}

/**
 * How delivery went, behind one disclosure on a registered relay: what this
 * server handed the relay lately (from its own ledger), the hand-off time,
 * and the relay's last status check. The pill says whether anything is
 * wrong; the figures are for when the admin wants to look.
 */
function PushRelayDelivery({ status }: { status: AdminPushRelayStatus }) {
  const { t } = useTranslations();
  if (!status.offered || !status.instanceId) return null;
  return (
    <Disclosure
      framed
      summary={t("admin.pushRelay.deliverySummary")}
      data-slot="push-relay-delivery"
    >
      <RelayUsage status={status} />
      {status.handoff && <PushRelayHandoff handoff={status.handoff} />}
      <PushRelayCheckLine status={status} />
    </Disclosure>
  );
}

/** What this server handed the relay lately, from its own ledger. */
function RelayUsage({ status }: { status: AdminPushRelayStatus }) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { usage, lastSuccessAt } = status;
  if (!usage) return null;
  const counts = [
    ["accepted", usage.accepted, t("admin.pushRelay.usage.accepted")],
    ["pending", usage.pending, t("admin.pushRelay.usage.pending")],
    ["dropped", usage.dropped, t("admin.pushRelay.usage.dropped")],
    ["failed", usage.failed, t("admin.pushRelay.usage.failed")],
  ] as const;
  return (
    <div className="space-y-1 text-xs" data-slot="push-relay-usage">
      <p className="font-medium">
        {t("admin.pushRelay.usage.window", { days: usage.windowDays })}
      </p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
        {counts.map(([key, value, label]) => (
          <div key={key}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium tabular-nums">{fmt.integer(value)}</dd>
          </div>
        ))}
      </dl>
      {lastSuccessAt || usage.lastFailure ? (
        <p className="text-muted-foreground">
          {lastSuccessAt
            ? t("admin.pushRelay.usage.lastSuccess", {
                time: fmt.dateTime(lastSuccessAt),
              })
            : ""}
          {lastSuccessAt && usage.lastFailure ? " " : ""}
          {usage.lastFailure
            ? t("admin.pushRelay.usage.lastFailure", {
                time: fmt.dateTime(usage.lastFailure.at),
                reason:
                  usage.lastFailure.reason ??
                  t("admin.pushRelay.usage.noReason"),
              })
            : ""}
        </p>
      ) : null}
    </div>
  );
}

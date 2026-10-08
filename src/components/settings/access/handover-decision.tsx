"use client";

import { useState } from "react";
import { BellRing, UserRoundCheck } from "lucide-react";
import Link from "next/link";

import { accessLabel } from "@/components/settings/access/managed-profile-handover";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { ApiError } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import {
  OWNER_CHOOSABLE_HANDOVER_ACCESS,
  type HandoverAccess,
} from "@/lib/managed-profiles/handover-access";
import {
  useDecideHandover,
  useHandoverDecision,
  type HandoverDecisionState,
} from "@/lib/queries/use-handover-decision";

type PendingDecision = NonNullable<HandoverDecisionState["pending"]>;

/**
 * v1.42 (#959) — the new owner's decision about each former Guardian.
 *
 * The claim already applied what the issuing Guardian proposed; this is where
 * the person whose record it is sees that and has the final word. Each row is
 * a Guardian, preselected at the access they hold now. A row whose access
 * moved since the claim (the Guardian stepped away, or the owner already
 * changed it under Shared access) is shown and left alone.
 *
 * Rendered in two places from one form: the screen the claim lands on, and a
 * card at the top of Settings → Shared access that stays until the decision
 * is made.
 */
export function HandoverDecisionForm({
  pending,
  onDecided,
  secondary,
}: {
  pending: PendingDecision;
  onDecided?: () => void;
  /** An extra action before the primary one (the setup screen's "later"). */
  secondary?: React.ReactNode;
}) {
  const { t } = useTranslations();
  const decide = useDecideHandover();
  const [choices, setChoices] = useState<Record<string, HandoverAccess>>({});

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (decide.isPending) return;
    decide.mutate(
      pending.guardians
        .filter((g) => g.decidable)
        .map((g) => ({
          grantId: g.grantId,
          access: choices[g.grantId] ?? g.current,
        })),
      { onSuccess: () => onDecided?.() },
    );
  };

  return (
    <form
      onSubmit={submit}
      data-slot="handover-decision-form"
      className="space-y-4"
    >
      {pending.guardians.length === 0 ? (
        <p className="text-sm">{t("recordSharing.handoverDecision.empty")}</p>
      ) : (
        <ul className="divide-y" data-slot="handover-decision-list">
          {pending.guardians.map((guardian) => {
            const id = `handover-decision-${guardian.grantId}`;
            return (
              <li
                key={guardian.grantId}
                data-slot="handover-decision-guardian"
                data-guardian-grant-id={guardian.grantId}
                data-decidable={guardian.decidable ? "true" : "false"}
                className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 flex-1">
                  <Label
                    noColon
                    htmlFor={guardian.decidable ? id : undefined}
                    className="block truncate pl-0 text-sm font-medium"
                  >
                    {guardian.displayName}
                  </Label>
                  <p className="text-muted-foreground truncate text-xs">
                    {guardian.decidable
                      ? t("recordSharing.handoverDecision.proposed", {
                          access: accessLabel(t, guardian.proposal),
                        })
                      : t("recordSharing.handoverDecision.settled")}
                  </p>
                </div>
                {guardian.decidable ? (
                  <NativeSelect
                    id={id}
                    data-slot="handover-decision-choice"
                    className="w-40 shrink-0"
                    value={choices[guardian.grantId] ?? guardian.current}
                    onChange={(e) =>
                      setChoices((current) => ({
                        ...current,
                        [guardian.grantId]: e.target.value as HandoverAccess,
                      }))
                    }
                  >
                    {OWNER_CHOOSABLE_HANDOVER_ACCESS.map((level) => (
                      <option key={level} value={level}>
                        {accessLabel(t, level)}
                      </option>
                    ))}
                  </NativeSelect>
                ) : (
                  <p className="shrink-0 text-sm">
                    {accessLabel(t, guardian.current)}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-sm">{t("recordSharing.handoverDecision.later")}</p>

      {decide.isError && (
        <p
          role="alert"
          data-slot="handover-decision-error"
          className="text-destructive text-sm"
        >
          {t(
            decide.error instanceof ApiError
              ? "recordSharing.handoverDecision.errorFailed"
              : "recordSharing.managed.errorOffline",
          )}
        </p>
      )}

      <SettingsCardActions>
        {secondary}
        <Button
          type="submit"
          size="sm"
          className="min-h-11 sm:min-h-9"
          data-slot="handover-decision-submit"
          disabled={decide.isPending}
        >
          {decide.isPending
            ? t("recordSharing.handoverDecision.saving")
            : t("recordSharing.handoverDecision.save")}
        </Button>
      </SettingsCardActions>
    </form>
  );
}

/**
 * The one-time pointer to the new owner's own notification channels.
 *
 * Reminders for a managed profile went to its Guardians. The claim ends that
 * fan-out, and the record has no channel of its own yet, so without this a
 * medication reminder would quietly stop reaching anybody.
 */
export function HandoverNotificationHint() {
  const { t } = useTranslations();
  return (
    <div
      data-slot="handover-notification-hint"
      className="flex items-start gap-3 rounded-lg border p-3"
    >
      <BellRing
        className="text-muted-foreground mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-medium">
          {t("recordSharing.handoverDecision.notificationsTitle")}
        </p>
        <p className="text-sm">
          {t("recordSharing.handoverDecision.notificationsBody")}
        </p>
        <Link
          href="/settings/notifications"
          className="text-primary text-sm underline"
          data-slot="handover-notification-link"
        >
          {t("recordSharing.handoverDecision.notificationsAction")}
        </Link>
      </div>
    </div>
  );
}

/**
 * Settings → Shared access: the decision, until it is made. Renders nothing
 * for every account that has none waiting, which is nearly all of them.
 */
export function HandoverDecisionCard() {
  const { t } = useTranslations();
  const decision = useHandoverDecision();
  const pending = decision.data?.pending;
  if (!pending) return null;

  return (
    <SettingsCard data-slot="handover-decision-card">
      <SettingsCardHeader
        icon={UserRoundCheck}
        title={t("recordSharing.handoverDecision.title")}
        description={t("recordSharing.handoverDecision.description")}
      />
      <HandoverNotificationHint />
      <HandoverDecisionForm pending={pending} />
    </SettingsCard>
  );
}

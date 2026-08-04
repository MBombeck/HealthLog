"use client";

import { FolderOpen, Loader2 } from "lucide-react";

import { GrantRowItem } from "@/components/settings/access/grant-row";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { useAccountSwitch } from "@/hooks/use-account-switch";
import { useTranslations } from "@/lib/i18n/context";
import { accountLabel } from "@/lib/sharing/account-access-view";
import {
  useAcceptGrant,
  useAccountGrants,
  useRenounceGrant,
  type GrantRow,
} from "@/lib/queries/use-account-grants";

/**
 * v1.36.0 — the records this account has been offered, and the ones it holds.
 *
 * The delegate's side. Three affordances, and the order they appear in is the
 * order somebody meets them:
 *
 *   * **Accept.** An invitation confers nothing until this button is pressed.
 *     That is the consent handshake, not a formality: being handed read access
 *     to another person's health record is not something to impose silently,
 *     and the acceptance is what the grant row records.
 *   * **Open.** Once accepted, the record can be opened from here as well as
 *     from the user menu — somebody who has just accepted is already looking
 *     at the row and should not have to go hunting for the switcher.
 *   * **Hand back.** The delegate's own way out, attributed as theirs so the
 *     owner's record can tell "I withdrew it" from "he gave it back".
 */
export function GrantsReceivedCard() {
  const { t } = useTranslations();
  const { data, isLoading, isError, refetch } = useAccountGrants();
  const accept = useAcceptGrant();
  const renounce = useRenounceGrant();
  const switchAccount = useAccountSwitch();

  const received = data?.received ?? [];

  return (
    <SettingsCard data-slot="grants-received-card">
      <SettingsCardHeader
        icon={FolderOpen}
        title={t("recordSharing.received.title")}
        description={t("recordSharing.received.description")}
      />
      <div className="mt-4">
        {isLoading && (
          <Loader2
            className="text-muted-foreground size-5 animate-spin motion-reduce:animate-none"
            aria-label={t("common.loading")}
          />
        )}
        {isError && (
          <QueryErrorCard
            title={t("recordSharing.received.loadError")}
            onRetry={() => void refetch()}
          />
        )}
        {!isLoading && !isError && received.length === 0 && (
          <EmptyState
            icon={<FolderOpen className="size-6" />}
            title={t("recordSharing.received.emptyTitle")}
            description={t("recordSharing.received.emptyDescription")}
          />
        )}
        {received.length > 0 && (
          <ul data-slot="grants-received-list" className="divide-y">
            {received.map((grant) => (
              <GrantRowItem
                key={grant.id}
                grant={grant}
                side="received"
                notice={renderConsent(grant)}
                actions={renderActions(grant)}
              />
            ))}
          </ul>
        )}
      </div>
    </SettingsCard>
  );

  /**
   * The delegate's half of the consent, on the screen where they give it.
   *
   * A write invitation asks for something a read invitation does not: that the
   * person put entries into somebody else's health record under their own
   * name, permanently, with no way to take one back. A manage invitation asks
   * for more again — that they change and remove what the owner wrote — and it
   * gets its own sentence rather than a stronger adjective on the write one,
   * because the two are different responsibilities and the difference is the
   * whole reason the third level exists. Both are worth one sentence before
   * the button rather than a sentence after the first entry.
   *
   * Shown only while the invitation is unanswered — once accepted, the level
   * and the sections are the row's own lines and this would be nagging.
   */
  function renderConsent(grant: GrantRow) {
    if (grant.state !== "PENDING") return null;
    if (grant.access === "MANAGE") {
      return (
        <p data-slot="grant-manage-consent" className="text-foreground text-sm">
          {t("recordSharing.received.manageConsent", {
            name: accountLabel(grant.account),
          })}
        </p>
      );
    }
    if (grant.access !== "WRITE") return null;
    return (
      <p data-slot="grant-write-consent" className="text-foreground text-sm">
        {t("recordSharing.received.writeConsent", {
          name: accountLabel(grant.account),
        })}
      </p>
    );
  }

  function renderActions(grant: GrantRow) {
    if (grant.state === "PENDING") {
      return (
        <Button
          size="sm"
          data-slot="grant-accept"
          disabled={accept.isPending}
          onClick={() => accept.mutate(grant.id)}
        >
          {accept.isPending
            ? t("recordSharing.received.accepting")
            : t("recordSharing.received.accept")}
        </Button>
      );
    }
    if (grant.state !== "ACTIVE") return null;
    const name = accountLabel(grant.account);
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          data-slot="grant-open"
          data-account-id={grant.account.id}
          disabled={switchAccount.isPending}
          onClick={() => switchAccount.mutate(grant.account.id)}
        >
          {t("recordSharing.received.open")}
        </Button>
        <ConfirmButton
          slot="grant-renounce"
          size="sm"
          label={t("recordSharing.received.renounce")}
          title={t("recordSharing.received.renounceTitle", { name })}
          body={t("recordSharing.received.renounceBody", { name })}
          confirmLabel={t("recordSharing.received.renounceConfirm")}
          pending={renounce.isPending}
          onConfirm={() => renounce.mutate(grant.id)}
        />
      </div>
    );
  }
}

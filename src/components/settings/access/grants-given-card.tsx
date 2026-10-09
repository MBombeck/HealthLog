"use client";

import { Loader2, Users } from "lucide-react";

import {
  GrantActionAlert,
  grantActionErrorKey,
} from "@/components/settings/access/grant-action-error";
import { GrantRowItem } from "@/components/settings/access/grant-row";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { useTranslations } from "@/lib/i18n/context";
import { accountLabel } from "@/lib/sharing/account-access-view";
import {
  useAccountGrants,
  useRevokeGrant,
  type GrantRow,
} from "@/lib/queries/use-account-grants";

/**
 * v1.36.0 — who can open this record.
 *
 * The compliance surface: at any moment the owner can see who has access, at
 * what level, since when, and whether it is still being used. Ended grants stay
 * in the list because the row is the consent record.
 *
 * Revoking asks once and then does it. No step-up, no typed confirmation —
 * reducing access must never be harder than granting it was, and the one party
 * here whose intent needs no verification is the person closing their own
 * health record to somebody. The confirm dialog exists only because the click
 * target sits in a list and a mis-tap should not end an access silently; it
 * names the person and the act.
 *
 * What the dialog SAYS depends on what the grant could do: see
 * {@link revokeBody}.
 */

export function GrantsGivenCard() {
  const { t } = useTranslations();
  const { data, isLoading, isError, refetch } = useAccountGrants();
  const revoke = useRevokeGrant();

  const given = data?.given ?? [];

  return (
    <SettingsCard data-slot="grants-given-card">
      <SettingsCardHeader
        anchor="shared-by-you"
        icon={Users}
        title={t("recordSharing.given.title")}
        description={t("recordSharing.given.description")}
      />
      <div>
        {isLoading && (
          <Loader2
            className="text-muted-foreground size-5 animate-spin motion-reduce:animate-none"
            aria-label={t("common.loading")}
          />
        )}
        {isError && (
          <QueryErrorCard
            title={t("recordSharing.given.loadError")}
            onRetry={() => void refetch()}
          />
        )}
        {!isLoading && !isError && given.length === 0 && (
          <EmptyState
            icon={<Users className="size-6" />}
            title={t("recordSharing.given.emptyTitle")}
            description={t("recordSharing.given.emptyDescription")}
          />
        )}
        {given.length > 0 && (
          <ul data-slot="grants-given-list" className="divide-y">
            {given.map((grant) => (
              <GrantRowItem
                key={grant.id}
                grant={grant}
                side="given"
                notice={renderFailure(grant)}
                actions={renderRevoke(grant)}
              />
            ))}
          </ul>
        )}
      </div>
    </SettingsCard>
  );

  /**
   * A refused revoke, on the row it was refused for.
   *
   * The confirm dialog has already closed by the time the server answers, so
   * without this a refusal is invisible: the list looks the same, and the one
   * refusal that matters — a managed profile that would be left with nobody
   * looking after it — arrived as silence. Read off the mutation rather than
   * copied into local state, so `variables` is what decides which row wears
   * it.
   */
  function renderFailure(grant: GrantRow) {
    if (!revoke.isError || revoke.variables !== grant.id) return null;
    return (
      <GrantActionAlert
        grantId={grant.id}
        message={t(grantActionErrorKey(revoke.error, "revoke"))}
        retrying={revoke.isPending}
        onRetry={() => revoke.mutate(grant.id)}
      />
    );
  }

  function renderRevoke(grant: GrantRow) {
    // Only a live grant can be ended. An already-ended row keeps its history
    // and loses its button, rather than offering an act that would 409.
    if (grant.state !== "ACTIVE" && grant.state !== "PENDING") return null;
    // The row and the window arrive together. A grant that can be revoked came
    // out of a resolved payload, so there is no state in which this control
    // exists and the number behind its disclosure does not.
    if (!data) return null;
    const name = accountLabel(grant.account);
    return (
      <ConfirmButton
        slot="grant-revoke"
        size="sm"
        label={
          grant.state === "PENDING"
            ? t("recordSharing.given.withdrawInvite")
            : t("recordSharing.given.revoke")
        }
        title={t("recordSharing.given.revokeTitle", { name })}
        body={revokeBody({
          t,
          access: grant.access,
          name,
          retentionDays: data.retentionDays,
        })}
        confirmLabel={t("recordSharing.given.revokeConfirm")}
        pending={revoke.isPending}
        onConfirm={() => revoke.mutate(grant.id)}
      />
    );
  }
}

/**
 * What ending this particular access does, as one paragraph.
 *
 * Exported and pure because the dialog it feeds only exists after a click, and
 * an SSR render cannot see inside it — the same reason `endOfDayIso` is
 * exported from the invite card. The composition is the thing worth pinning:
 * which sentences appear, and which one is omitted when its number is unknown.
 *
 * Two extra sentences for a grant that could put something in the record, and
 * only for one: a read grant never did, so telling its owner that "anything
 * they entered stays" would describe something that cannot have happened. The
 * condition is "not READ" rather than "is WRITE", so the level that can also
 * change and remove entries carries both sentences too — for a manage grant
 * the question "what happens to what they did" is the sharper one, not the
 * softer. The last sentence is the honest bound on attribution: the activity
 * view answers "who entered what" for as long as the audit window reaches, and
 * that window is the operator's setting.
 *
 * v1.37.0 — `retentionDays` is required, and that is the whole fix. It used to
 * be optional and came from a second query, so the disclosure appeared only
 * when that query happened to have answered: two owners performing the same
 * act read different paragraphs, and the one who read less had no way to tell.
 * The number rides the grant list now, so a caller with a grant to revoke
 * cannot be without it and this function has no branch that omits the
 * sentence.
 */
export function revokeBody({
  t,
  access,
  name,
  retentionDays,
}: {
  t: (key: string, params?: Record<string, string | number>) => string;
  access: GrantRow["access"];
  name: string;
  /** The audit window, off the same payload the row came from. */
  retentionDays: number;
}): string {
  const lines = [t("recordSharing.given.revokeBody", { name })];
  if (access !== "READ") {
    lines.push(t("recordSharing.given.revokeEntriesStay"));
    lines.push(
      t("recordSharing.given.revokeAttribution", { days: retentionDays }),
    );
  }
  return lines.join(" ");
}

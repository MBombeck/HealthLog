"use client";

import { useState } from "react";
import { UserRoundCog } from "lucide-react";

import {
  GrantActionAlert,
  grantActionErrorKey,
} from "@/components/settings/access/grant-action-error";
import { ManagedProfileCreateForm } from "@/components/settings/access/managed-profile-create-form";
import { ManagedProfileEditForm } from "@/components/settings/access/managed-profile-edit-form";
import { ManagedProfileGuardians } from "@/components/settings/access/managed-profile-guardians";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import {
  useDeleteManagedProfile,
  useManagedProfileGuardians,
  type ManagedProfileGuardian,
} from "@/lib/queries/use-managed-profiles";
import {
  accountLabel,
  type AccountAccessEntry,
} from "@/lib/sharing/account-access-view";

/**
 * v1.37.0 — the records this account looks after.
 *
 * ## Why the list is not a read of its own
 *
 * There is no `GET /api/managed-profiles`, and there does not need to be. A
 * Guardian's relationship to a managed profile IS a MANAGE grant with the
 * profile as grantor, so the profiles somebody looks after are already on
 * `GET /api/auth/me` as the `managed` entries of `accountAccess.accounts` —
 * the same list that paints the switcher. Reading them from anywhere else
 * would be a second answer to a question the account payload already answers,
 * and the two would disagree the first time a grant lapsed.
 *
 * It is also what makes the creation contract simple to state: the new profile
 * appears here, in the switcher and in the banner from ONE invalidation, and
 * if the account payload is not refreshed it appears in none of them.
 *
 * ## Why this card, in this section
 *
 * The section's docblock states the rule — one concept, one section — and this
 * is the same concept from the third side: who can open a record. Two of the
 * cards here are about another adult opening yours or you opening theirs; this
 * one is about a record that exists only because somebody looks after it. A
 * settings area of its own would split "who may open which record" across two
 * pages, which is the split that rule exists to prevent.
 *
 * It sits directly after the invitation card because both are acts, and this
 * one creates the record the other two then talk about.
 *
 * ## One deletion mutation for the whole card
 *
 * Hoisted here rather than instantiated per row, so `variables` is what says
 * WHICH profile was refused — the same shape `grants-given-card.tsx` uses, and
 * the reason a static render can assert a failure state at all. The failure is
 * read off the mutation rather than copied into a `useState`, so an unrelated
 * invalidation cannot clear it and a second failure cannot paint one row's
 * message onto another's.
 */
export function ManagedProfileCard() {
  const { t } = useTranslations();
  const { user } = useAuth();
  const remove = useDeleteManagedProfile();
  const profiles = managedProfilesOf(user?.accountAccess?.accounts);

  return (
    <SettingsCard data-slot="managed-profile-card">
      <SettingsCardHeader
        icon={UserRoundCog}
        title={t("recordSharing.managed.title")}
        description={t("recordSharing.managed.description")}
      />
      <div className="space-y-4">
        {/* Content, not meta: this is what somebody is consenting to take on,
            and UI-STANDARDS §3 reserves muted for the incidental. */}
        <p data-slot="managed-profile-explainer" className="text-sm">
          {t("recordSharing.managed.explainer")}
        </p>

        {profiles.length > 0 && (
          <ul data-slot="managed-profile-list" className="divide-y">
            {profiles.map((profile) => (
              <ManagedProfileRow
                key={profile.accountId}
                profile={profile}
                remove={remove}
              />
            ))}
          </ul>
        )}

        <ManagedProfileCreateForm />
      </div>
    </SettingsCard>
  );
}

/**
 * One profile: who it is, and the way to end it.
 *
 * The roster read lives here rather than in the card because it is per
 * profile, and because the delete control depends on it: the confirm copy
 * states how many people lose the record, and that number has to come from the
 * read that produced the row rather than from a local counter. The control is
 * withheld until the roster has answered, for the same reason `grants-given-
 * card.tsx` withholds its revoke until the retention window is in hand — a
 * disclosure that appears or not depending on which request landed first is
 * the defect that release already paid for once.
 *
 * A roster that 404s is a profile this account is no longer a Guardian of (the
 * account payload can be that much stale), and it leaves the row visible with
 * no destructive control, which is the right way round.
 */
function ManagedProfileRow({
  profile,
  remove,
}: {
  profile: AccountAccessEntry;
  remove: ReturnType<typeof useDeleteManagedProfile>;
}) {
  const { t, tCount } = useTranslations();
  const guardians = useManagedProfileGuardians(profile.accountId);
  const name = accountLabel(profile);
  const failed = remove.isError && remove.variables === profile.accountId;
  // Per row, not per card. The edit form reads the record's identity when it
  // opens, so one shared flag would put every row's form on the wire the
  // moment any of them was opened.
  const [editing, setEditing] = useState(false);

  return (
    <li
      data-slot="managed-profile-row"
      data-managed-profile-id={profile.accountId}
      className="space-y-2 py-3 first:pt-0 last:pb-0"
    >
      {/* UI-STANDARDS §11 inline action row. */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {/* A person's name is user data and stays content. */}
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="text-muted-foreground truncate text-xs">
            {t("recordSharing.lookingAfter.kindManaged")}
          </p>
        </div>
        {/* UI-STANDARDS §11: the actions stay beside the name, never below it.
            Edit is offered without waiting for the roster — it changes what the
            record IS and does not depend on how many people look after it,
            unlike the deletion beside it, whose confirm copy states that
            number and therefore cannot exist before the roster answers. */}
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            data-slot="managed-profile-edit"
            aria-expanded={editing}
            onClick={() => setEditing((open) => !open)}
          >
            {t("recordSharing.managed.edit")}
          </Button>
          {guardians.data && (
            <ConfirmButton
              slot="managed-profile-delete"
              size="sm"
              className="min-h-11 sm:min-h-9"
              label={t("recordSharing.managed.delete")}
              title={t("recordSharing.managed.deleteTitle", { name })}
              body={deleteProfileBody({
                t,
                tCount,
                name,
                activeGuardians: activeGuardianCount(guardians.data),
              })}
              confirmLabel={t("recordSharing.managed.deleteConfirm")}
              pending={remove.isPending}
              onConfirm={() => remove.mutate(profile.accountId)}
            />
          )}
        </div>
      </div>
      {editing && (
        <ManagedProfileEditForm
          profileId={profile.accountId}
          onDone={() => setEditing(false)}
        />
      )}
      {failed && (
        <GrantActionAlert
          grantId={profile.accountId}
          message={t(grantActionErrorKey(remove.error, "deleteProfile"))}
          retrying={remove.isPending}
          onRetry={() => remove.mutate(profile.accountId)}
        />
      )}
      {/* A failed roster read is not an absent roster.
          Without this branch a 500 renders exactly as a still-loading one —
          the row with no guardian panel and no delete control — and the person
          waits for something that is never coming. UI-STANDARDS §6: a read
          that failed says so and offers the way back. It is deliberately NOT
          the same as the 404 arm: a 404 means this account is no longer a
          Guardian of that profile, which is an answer, and the row correctly
          shows no destructive control for it. */}
      {guardians.isError && (
        <QueryErrorCard
          title={t("recordSharing.managed.rosterLoadError")}
          onRetry={() => void guardians.refetch()}
        />
      )}
      {guardians.data && (
        <ManagedProfileGuardians
          profileId={profile.accountId}
          profileName={name}
          roster={guardians.data}
        />
      )}
    </li>
  );
}

/**
 * The managed entries of the account payload, in the order the server sent
 * them.
 *
 * Exported and pure so the filter can be pinned: `recordKind` is server-
 * resolved presentation metadata, and a card that showed every shared record
 * here would offer a delete control for an adult's own account.
 */
export function managedProfilesOf(
  accounts: AccountAccessEntry[] | undefined,
): AccountAccessEntry[] {
  return (accounts ?? []).filter((entry) => entry.recordKind === "managed");
}

/**
 * How many people actually hold this record right now.
 *
 * ACTIVE only, which is the same rule `activeGuardianWhere` enforces
 * server-side: an invitation nobody has accepted confers nothing, and counting
 * it would tell somebody two people lose the record when one does.
 */
export function activeGuardianCount(
  roster: ManagedProfileGuardian[] | undefined,
): number {
  return (roster ?? []).filter((guardian) => guardian.state === "ACTIVE")
    .length;
}

/**
 * What deleting this profile does, as one paragraph.
 *
 * Exported and pure because the dialog it feeds only exists after a click and
 * an SSR render cannot see inside it — the same reason `revokeBody` is
 * exported from the grants card. The composition is the thing worth pinning.
 *
 * Three sentences, and the third is the one that is easy to leave out. The
 * delete route emits NO last-Guardian refusal, and that is not an oversight:
 * deleting the profile is the documented way out of the floor. A Guardian may
 * not strand a record with nobody looking after it, but they may end the
 * record. Saying so here is better than duplicating a refusal this route never
 * sends.
 */
export function deleteProfileBody({
  t,
  tCount,
  name,
  activeGuardians,
}: {
  t: (key: string, params?: Record<string, string | number>) => string;
  tCount: (
    baseKey: string,
    count: number,
    params?: Record<string, string | number>,
  ) => string;
  name: string;
  /** Taken from the roster read, never from a local counter. */
  activeGuardians: number;
}): string {
  return [
    t("recordSharing.managed.deleteBody", { name }),
    tCount("recordSharing.managed.deleteGuardians", activeGuardians, {
      count: activeGuardians,
    }),
    t("recordSharing.managed.deleteFloorNote"),
  ].join(" ");
}

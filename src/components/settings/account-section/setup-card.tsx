"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { showErrorToast } from "@/lib/errors/error-toast";
import { ListChecks, Loader2 } from "lucide-react";

import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";

import { Button } from "@/components/ui/button";
import { InlineAction } from "@/components/ui/inline-action";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import {
  PERSON_TASK_ROWS,
  SetupTaskRow,
} from "@/components/onboarding/setup-task-rows";
import { useOnboardingRestart } from "@/components/onboarding/use-onboarding-flow";
import {
  useSetupCardDismissal,
  useSetupState,
} from "@/components/onboarding/use-setup-state";
import { useAuth } from "@/hooks/use-auth";
import { localizedApiError } from "@/lib/api/localized-error";
import { useTranslations } from "@/lib/i18n/context";
import { resetChecklistDismissals } from "@/lib/onboarding/checklist-storage";

/**
 * Settings › Account › Setup.
 *
 * The same rows the dashboard's setup card lists (1.50), always, whether or
 * not the card is hidden, each leading to where it is done; an admin finds
 * the server's own rows one link away. "Show on the dashboard again" brings
 * back a hidden card (or the older checklist this browser hid), and "Set up
 * again" asks the questions once more through the restart route, which keeps
 * the answers as prefill and writes no module state.
 */
export function SetupCard() {
  const { t } = useTranslations();
  const router = useRouter();
  const { user } = useAuth();
  const restart = useOnboardingRestart();
  const setup = useSetupState();
  const dismissal = useSetupCardDismissal();
  const person = setup.data?.person;

  async function setUpAgain() {
    if (restart.isPending) return;
    try {
      await restart.mutateAsync();
      router.push("/onboarding/who");
    } catch (err) {
      showErrorToast(localizedApiError(err, t, "onboarding.errorGeneric"), {
        cause: err,
      });
    }
  }

  async function showOnDashboard() {
    const checklistBack = resetChecklistDismissals();
    let cardBack = false;
    if (person?.planned && person.cardDismissed) {
      try {
        await dismissal.mutateAsync(false);
        cardBack = true;
      } catch (err) {
        showErrorToast(localizedApiError(err, t, "onboarding.errorGeneric"), {
          cause: err,
        });
        return;
      }
    }
    // Something was hidden and is back: a written outcome. Nothing was
    // hidden: an empty one, there was nothing to bring back.
    if (checklistBack || cardBack) {
      toastWrittenOutcome("success", t("settings.setup.checklistShown"));
    } else {
      toastWrittenOutcome("empty", t("settings.setup.checklistNothingHidden"));
    }
  }

  return (
    <SettingsCard data-slot="settings-setup-card">
      <SettingsCardHeader
        icon={ListChecks}
        title={t("settings.setup.title")}
        description={t("settings.setup.description")}
      />
      {person && person.tasks.length > 0 ? (
        <ul
          className="border-border divide-border -mx-4 divide-y border-y md:-mx-6"
          data-slot="settings-setup-tasks"
        >
          {person.tasks.map((task) => {
            const row = PERSON_TASK_ROWS[task.id];
            return (
              <SetupTaskRow
                key={task.id}
                task={task}
                kind="person"
                href={row.href}
                Icon={row.Icon}
              />
            );
          })}
        </ul>
      ) : null}
      {user?.role === "ADMIN" ? (
        <p className="text-sm">
          <InlineAction asChild size="sm">
            <Link href="/admin/setup">{t("setup.admin.link")}</Link>
          </InlineAction>
        </p>
      ) : null}
      <SettingsCardActions>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void showOnDashboard()}
          disabled={dismissal.isPending}
          data-slot="settings-show-checklist"
        >
          {t("settings.setup.showChecklist")}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={setUpAgain}
          disabled={restart.isPending}
          data-slot="settings-set-up-again"
        >
          {restart.isPending ? (
            <Loader2
              aria-hidden="true"
              className="size-4 animate-spin motion-reduce:animate-none"
            />
          ) : null}
          {t("settings.setup.setUpAgain")}
        </Button>
      </SettingsCardActions>
    </SettingsCard>
  );
}

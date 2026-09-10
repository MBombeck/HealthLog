"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ListChecks, Loader2 } from "lucide-react";

import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";

import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useOnboardingRestart } from "@/components/onboarding/use-onboarding-flow";
import { localizedApiError } from "@/lib/api/localized-error";
import { useTranslations } from "@/lib/i18n/context";
import { resetChecklistDismissals } from "@/lib/onboarding/checklist-storage";

/**
 * v1.39 (C2) — Settings → Account → Setup.
 *
 * The two ways back into the first-run experience (design spec §Principles 4
 * and §After the flow). "Set up again" asks the questions once more through
 * the restart route, which resets the ledger and keeps the answers as
 * prefill — and writes no module state, so a module switched on by hand is
 * never switched off by a re-run. "Show the checklist again" forgets what
 * this browser hid; the checklist's dismissals live in the browser, so the
 * button lives on the same origin.
 */
export function SetupCard() {
  const { t } = useTranslations();
  const router = useRouter();
  const restart = useOnboardingRestart();

  async function setUpAgain() {
    if (restart.isPending) return;
    try {
      await restart.mutateAsync();
      router.push("/onboarding/who");
    } catch (err) {
      toast.error(localizedApiError(err, t, "onboarding.errorGeneric"));
    }
  }

  function showChecklist() {
    // Something was hidden and is back: a written outcome. Nothing was
    // hidden: an empty one — there was nothing to bring back.
    if (resetChecklistDismissals()) {
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
      <SettingsCardActions>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11"
          onClick={showChecklist}
          data-slot="settings-show-checklist"
        >
          {t("settings.setup.showChecklist")}
        </Button>
        <Button
          type="button"
          size="sm"
          className="min-h-11"
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

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { StepHeading } from "@/components/onboarding/step-heading";
import {
  HandoverDecisionForm,
  HandoverNotificationHint,
} from "@/components/settings/access/handover-decision";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/ui/logo";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { useTranslations } from "@/lib/i18n/context";
import { useHandoverDecision } from "@/lib/queries/use-handover-decision";

/**
 * v1.42 (#959) — the first screen after claiming a managed profile.
 *
 * The claim applied the access each Guardian was proposed; here the new owner
 * sees it and decides. It lives under `/onboarding/` because a claimed
 * account starts with its setup owed and the proxy walls everything else off
 * until that is done; the setup's front door sends a pending decision here
 * first (`src/app/onboarding/page.tsx`).
 *
 * "Later" is honest: the proposal keeps holding, and the same decision waits
 * at the top of Settings → Shared access until it is made.
 */
export default function HandoverDecisionPage() {
  const { t } = useTranslations();
  const router = useRouter();
  const decision = useHandoverDecision();
  const pending = decision.data?.pending;
  const nothingWaiting = decision.data !== undefined && pending === null;

  useEffect(() => {
    if (nothingWaiting) router.replace("/onboarding");
  }, [nothingWaiting, router]);

  const continueSetup = (later: boolean) =>
    router.push(later ? "/onboarding?handover=later" : "/onboarding");

  return (
    <div
      className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 pt-6 pb-[max(env(safe-area-inset-bottom),1rem)]"
      data-slot="handover-decision-screen"
    >
      <header className="flex items-center">
        <Logo size={32} />
      </header>

      <StepHeading
        id="handover-decision-heading"
        title={t("recordSharing.handoverDecision.title")}
        description={t("recordSharing.handoverDecision.description")}
      />

      {decision.isError ? (
        <QueryErrorCard
          title={t("recordSharing.handoverDecision.loadError")}
          onRetry={() => void decision.refetch()}
        />
      ) : !pending ? (
        <p
          role="status"
          className="text-muted-foreground flex items-center gap-2 text-sm"
        >
          <Loader2
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          {t("nav.loadingScreen")}
        </p>
      ) : (
        <>
          <HandoverNotificationHint />
          <HandoverDecisionForm
            pending={pending}
            onDecided={() => continueSetup(false)}
            secondary={
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 sm:min-h-9"
                data-slot="handover-decision-later"
                onClick={() => continueSetup(true)}
              >
                {t("recordSharing.handoverDecision.decideLater")}
              </Button>
            }
          />
        </>
      )}
    </div>
  );
}

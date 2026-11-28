"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { useOnboardingComplete } from "@/components/onboarding/use-onboarding-flow";
import { useDismissServerSetupNotice } from "@/lib/queries/use-server-setup";
import { localizedApiError } from "@/lib/api/localized-error";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";

/**
 * "Finish later", top right on every setup screen after the first (1.50).
 *
 *  - Person flow: ends the first-run redirect (`POST /api/onboarding/complete`
 *    with no body, which stamps the account and derives nothing from a flow
 *    that is not finished) and opens the dashboard. Everything answered so
 *    far stays; the setup card's first row leads back to where it stopped.
 *  - Server setup: sets the setup aside for this admin (the notice's own
 *    "later"), leaving every open step open, and goes on to the owner's own
 *    setup. Admin › Setup lists the open steps.
 */
export function FinishLaterButton({ flow }: { flow: "person" | "server" }) {
  const { t } = useTranslations();
  const router = useRouter();
  const complete = useOnboardingComplete();
  const dismiss = useDismissServerSetupNotice();
  const [busy, setBusy] = useState(false);

  async function finishLater() {
    if (busy) return;
    setBusy(true);
    try {
      if (flow === "person") {
        await complete.mutateAsync(undefined);
        router.push("/");
      } else {
        await dismiss.mutateAsync();
        router.push("/onboarding");
      }
      router.refresh();
    } catch (err) {
      setBusy(false);
      showErrorToast(localizedApiError(err, t, "onboarding.errorGeneric"), {
        cause: err,
      });
    }
  }

  return (
    <button
      type="button"
      onClick={() => void finishLater()}
      disabled={busy}
      aria-busy={busy || undefined}
      data-slot="onboarding-finish-later"
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -mr-2 inline-flex min-h-11 items-center rounded-md px-2 text-sm focus-visible:ring-[3px] focus-visible:outline-none disabled:opacity-50"
    >
      {t("setup.finishLater")}
    </button>
  );
}

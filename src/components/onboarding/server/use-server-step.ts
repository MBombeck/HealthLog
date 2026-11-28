"use client";

import { useRouter } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { useServerSetupStep } from "@/lib/queries/use-server-setup";
import {
  nextServerSetupStep,
  type ServerSetupStepId,
} from "@/lib/admin/server-setup";
import { localizedApiError } from "@/lib/api/localized-error";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";

export function serverSetupHref(step: ServerSetupStepId): string {
  return `/onboarding/server/${step}`;
}

/**
 * Record one server setup step and go on (1.50). The step's own decision is
 * written by its domain route first, by the screen; this records the step on
 * the setup ledger only after that write succeeded, so there is never a
 * second Save. After the last step the owner continues into their own setup.
 */
export function useServerStep(step: ServerSetupStepId) {
  const { t } = useTranslations();
  const router = useRouter();
  const { user } = useAuth();
  const write = useServerSetupStep();

  async function record(status: "done" | "skipped"): Promise<void> {
    await write.mutateAsync({ step, status });
    let next = nextServerSetupStep(step);
    // A server whose relay cannot be used (an APNs key of its own, the relay
    // switched off in the environment) has no relay question: the step is
    // passed on the way and the setup goes on to AI.
    if (next === "relay" && user?.push?.relay?.canDecide !== true) {
      await write.mutateAsync({ step: "relay", status: "skipped" });
      next = nextServerSetupStep("relay");
    }
    router.push(next ? serverSetupHref(next) : "/onboarding");
    if (!next) router.refresh();
  }

  function fail(err: unknown) {
    showErrorToast(localizedApiError(err, t, "onboarding.errorGeneric"), {
      cause: err,
    });
  }

  return { record, fail, pending: write.isPending };
}

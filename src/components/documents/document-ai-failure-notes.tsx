"use client";

/**
 * #1404 — why background AI work on this document stopped: making it
 * searchable, or reading its values or filing suggestions. One line per kind,
 * from the reasons the server recorded (`aiFailures` on the detail); the
 * summary's own reason sits in its block. A failed read can be started again
 * from here when the person may run AI on the record. Rendered whatever the
 * capability says now, because a reason such as "no provider" is exactly the
 * case where the AI actions are hidden.
 */
import { RotateCw } from "lucide-react";

import { AiJobFailureLine } from "@/components/ai/ai-job-failure-line";
import { Button } from "@/components/ui/button";
import type { AiJobFailureDto } from "@/lib/ai/job-failure/types";
import { useTranslations } from "@/lib/i18n/context";

export function DocumentAiFailureNotes({
  failures,
  canRetry,
  retryPending,
  onRetry,
}: {
  failures: readonly AiJobFailureDto[] | undefined;
  /** The person may start the read again (the AI actions are available). */
  canRetry: boolean;
  retryPending: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslations();
  const shown = (failures ?? []).filter(
    (failure) =>
      failure.job === "documentIndex" || failure.job === "documentRead",
  );
  if (shown.length === 0) return null;
  return (
    <section className="space-y-2" data-slot="document-ai-failures">
      {shown.map((failure) => (
        <AiJobFailureLine key={failure.job} failure={failure} withJob />
      ))}
      {canRetry && shown.some((f) => f.job === "documentIndex") ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-slot="document-ai-failures-retry"
          disabled={retryPending}
          onClick={onRetry}
        >
          <RotateCw className="size-4" aria-hidden />
          {t("aiRuns.jobFailure.retry")}
        </Button>
      ) : null}
    </section>
  );
}

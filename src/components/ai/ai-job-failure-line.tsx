"use client";

/**
 * #1404 — one background AI failure in plain words: what stopped and why,
 * with when it last happened. Rendered on the document (under its summary
 * and its read) and in the Settings, AI list, from the closed codes the
 * server records; the client derives nothing.
 */
import {
  isAiJobFailureCode,
  isAiJobKind,
  type AiJobFailureDto,
} from "@/lib/ai/job-failure/types";
import { useTranslations } from "@/lib/i18n/context";

/** The sentence for a failure's code; an unknown code reads as a provider error. */
export function aiJobFailureReasonKey(code: string): string {
  return `aiRuns.jobFailure.code.${isAiJobFailureCode(code) ? code : "provider_error"}`;
}

/** The label of a failure's kind; an unknown kind reads as other work. */
export function aiJobFailureJobKey(job: string): string {
  return `aiRuns.jobFailure.job.${isAiJobKind(job) ? job : "other"}`;
}

export function AiJobFailureLine({
  failure,
  withJob = false,
  slot = "ai-job-failure",
}: {
  failure: AiJobFailureDto;
  /** Name the kind of work before the reason (the settings list does). */
  withJob?: boolean;
  slot?: string;
}) {
  const { t, locale } = useTranslations();
  const when = new Date(failure.lastFailedAt).toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const reason = t(aiJobFailureReasonKey(failure.code));
  return (
    <div data-slot={slot} data-code={failure.code} className="space-y-0.5">
      <p className="text-sm">
        {withJob
          ? t("aiRuns.jobFailure.line", {
              job: t(aiJobFailureJobKey(failure.job)),
              reason,
            })
          : reason}
      </p>
      <p className="text-muted-foreground text-xs">
        {failure.failCount > 1
          ? t("aiRuns.jobFailure.repeated", {
              count: failure.failCount,
              when,
            })
          : t("aiRuns.jobFailure.lastAt", { when })}
      </p>
    </div>
  );
}

/**
 * How the nightly briefing pass settles an account whose generation came back
 * `failed` (#1384).
 *
 * A failure used to be one of three things: screened, a dead sign-in, or a
 * provider failure worth a retry in 45 minutes. Two cases were missing, and
 * both made a self-hoster's only account read as a failing run every night,
 * which the repeated-failure alert then reported as a broken job:
 *
 *   - Every provider of the chain was benched for background work by the
 *     provider health ledger (#1279), so no request was sent. The account was
 *     not attempted tonight; its earlier failures were counted by the runs
 *     that made them, and a retry would find the same bench. It is `skipped`.
 *   - The provider refused the credential. A refused credential does not heal
 *     in 45 minutes, so no retry is queued, and whose credential it was
 *     decides who has to act. The operator's shared key or central sign-in is
 *     the operator's to fix, and a run where it was refused for everyone is a
 *     failing run: `failed`. The account's own key, gateway or sign-in is its
 *     owner's to fix: `auth_failed`, which the run reports but does not fail
 *     over (`job-run-report.ts`). An API key revoked at its issuer stays saved
 *     and is refused again every night, unlike a ChatGPT sign-in, which the
 *     refusal parks.
 *
 * The model answered and the safety screen withheld it (`outbound-screened`)
 * stays `screened` with no retry: asking the same model again in 45 minutes
 * is the same question, and it was screened eight times a night.
 */
import { isOperatorHeldProvider } from "@/lib/ai/provider-egress";
import type { GenerateOutcome } from "@/lib/insights/comprehensive-generate";
import type { JobRunCandidate, JobRunOutcome } from "@/lib/jobs/job-run-report";

type FailedGeneration = Extract<GenerateOutcome, { status: "failed" }>;

export interface FailedGenerationVerdict {
  outcome: JobRunOutcome;
  /** The run line's cause: the reason, and the provider that failed first. */
  cause: string;
  /** False when nothing was sent: the account is tallied as skipped. */
  attempted: boolean;
  /** Queue the bounded 45-minute retry for this account. */
  retry: boolean;
}

export function settleFailedGeneration(
  generated: FailedGeneration,
): FailedGenerationVerdict {
  if (generated.sentNothing) {
    return {
      outcome: "skipped",
      cause: "provider_benched",
      attempted: false,
      retry: false,
    };
  }
  const cause = generated.provider
    ? `${generated.reason}:${generated.provider}`
    : generated.reason;
  if (generated.reason === "outbound-screened") {
    return { outcome: "screened", cause, attempted: true, retry: false };
  }
  if (generated.credentialExpired) {
    const operatorHeld =
      generated.provider !== undefined &&
      isOperatorHeldProvider(generated.provider);
    return {
      outcome: operatorHeld ? "failed" : "auth_failed",
      cause,
      attempted: true,
      retry: false,
    };
  }
  return { outcome: "failed", cause, attempted: true, retry: true };
}

/** The first failed account of a run: its reason and the provider, if known. */
export interface FirstFailure {
  reason: string;
  provider: string | null;
}

/**
 * The first failed account's reason and provider, read back off the run's
 * causes, for the job's facts: what the admin page and the repeated-failure
 * alert show for a run that completed with every account failed.
 */
export function firstFailure(
  candidates: readonly JobRunCandidate[],
): FirstFailure | null {
  const cause = candidates.find((c) => c.outcome === "failed")?.cause;
  if (!cause) return null;
  const [reason, provider] = cause.split(":");
  return { reason, provider: provider ?? null };
}

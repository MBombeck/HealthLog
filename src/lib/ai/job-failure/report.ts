/**
 * #1404 — the one reporter every background AI job routes its failures
 * through, so the reason reaches the person instead of staying in a log.
 *
 * `trackAiJob(scope, fn)` runs one job's work under a witness (`./witness.ts`)
 * and, when it ends, settles what the witness saw, per kind of work:
 *
 *   - a provider call that answered last: the work succeeded, and an earlier
 *     record for it is deleted;
 *   - provider calls that failed with none answering after them: recorded, as
 *     the code their failure kinds share (`./classify.ts`);
 *   - a capability refusal, or a failure the job noted itself (a spent budget,
 *     a file the provider cannot read): recorded;
 *   - nothing AI-related: nothing changes.
 *
 * A thrown provider error or capability refusal that no shared place saw is
 * classified from the value; the value is rethrown unchanged.
 *
 * Which refusals count: one that is somebody's decision (a switch, a module,
 * the AI analysis opt-out, the usage level) is not a failure and is never
 * recorded. A missing provider or consent is recorded only when the person
 * asked for this work (`requested`: the automatic document read they switched
 * on, a read they started) or bound the capability to a named chain (then
 * `chain_no_provider`); a record that never set AI up is not told every night
 * that its AI is not set up.
 *
 * Work of another capability inside the same job (the nightly warm writes the
 * briefing and then the status notes) is recorded under that capability's own
 * kind (`CAPABILITY_JOB_KIND`), never under the job's.
 *
 * What is stored is a closed code, the provider type and a count, and nothing
 * else: no message, prompt, reply or provider payload, so no secret can land
 * in the row. The log line beside it carries the same closed values through
 * the central redaction (`emitSignal`).
 *
 * Never throws on its own account: a failure to report must not fail the job.
 */
import { prisma } from "@/lib/db";
import { emitSignal, logCaught } from "@/lib/logging/signal";
import type {
  AiCapabilityKey,
  AiUnavailableReason,
} from "@/lib/ai/capabilities/types";
import { chainSelectionFor, parseNamedChains } from "@/lib/ai/named-chains";

import {
  codeForProviderCalls,
  codeForProviderError,
  codeForRefusal,
  DELIBERATE_REFUSALS,
  refusalOf,
  type ProviderCallFailure,
} from "./classify";
import {
  AI_JOB_CAPABILITY,
  AI_JOB_FAILURE_RETENTION_MS,
  type AiJobFailureCode,
  type AiJobKind,
} from "./types";
import { withAiJobWitness, type AiJobWitness } from "./witness";

export interface AiJobScope {
  /** The record the work is for. */
  userId: string;
  job: AiJobKind;
  /** The document the work is about, when it is about one. */
  documentId?: string | null;
  /**
   * The person asked for this work: they started it, or switched on the
   * automatic run that started it. A missing provider or consent is then a
   * reason they need, not a setup state.
   */
  requested?: boolean;
}

/**
 * The kind a capability's work is recorded under when it runs inside a job of
 * another capability. A capability absent here is recorded only under a job
 * of its own.
 */
const CAPABILITY_JOB_KIND: Partial<Record<AiCapabilityKey, AiJobKind>> = {
  briefing: "briefing",
  statusText: "statusText",
  periodNarrative: "periodNarrative",
  workoutInsights: "workoutInsight",
  reactionLines: "reactionLine",
};

type Settled =
  | { state: "none" }
  | { state: "served" }
  | {
      state: "failing";
      calls: ProviderCallFailure[];
      providerType: string;
    }
  | { state: "refused"; reason: AiUnavailableReason; tentative: boolean }
  | { state: "code"; code: AiJobFailureCode; providerType: string | null };

async function persist(
  scope: AiJobScope,
  code: AiJobFailureCode,
  providerType: string | null,
  durationMs: number,
): Promise<void> {
  const now = new Date();
  const subjectId = scope.documentId ?? "";
  await prisma.aiJobFailure.upsert({
    where: {
      userId_job_subjectId: { userId: scope.userId, job: scope.job, subjectId },
    },
    create: {
      userId: scope.userId,
      job: scope.job,
      subjectId,
      code,
      providerType,
      firstFailedAt: now,
      lastFailedAt: now,
    },
    update: {
      code,
      providerType,
      failCount: { increment: 1 },
      lastFailedAt: now,
    },
  });
  // Self-limiting: whatever has not failed again within the retention window
  // is history, and goes with the next write for the record.
  await prisma.aiJobFailure.deleteMany({
    where: {
      userId: scope.userId,
      lastFailedAt: {
        lt: new Date(now.getTime() - AI_JOB_FAILURE_RETENTION_MS),
      },
    },
  });
  emitSignal({
    action: "ai.job.failed",
    level: "warn",
    meta: {
      job: scope.job,
      capability: AI_JOB_CAPABILITY[scope.job],
      code,
      provider: providerType,
      document: Boolean(scope.documentId),
    },
    // How long the job ran before it ended this way (#1404).
    durationMs,
  });
}

async function clear(scope: AiJobScope): Promise<void> {
  await prisma.aiJobFailure.deleteMany({
    where: {
      userId: scope.userId,
      job: scope.job,
      subjectId: scope.documentId ?? "",
    },
  });
}

/** Whether the job's capability is bound to one of the record's named chains. */
async function capabilityIsPinned(scope: AiJobScope): Promise<boolean> {
  const row = await prisma.user.findUnique({
    where: { id: scope.userId },
    select: { aiNamedChains: true },
  });
  const config = parseNamedChains(row?.aiNamedChains ?? null);
  return (
    chainSelectionFor(config, AI_JOB_CAPABILITY[scope.job]).kind === "pinned"
  );
}

/** The code a refusal is recorded as, or null when it is not recorded. */
async function refusalCode(
  scope: AiJobScope,
  reason: AiUnavailableReason,
): Promise<AiJobFailureCode | null> {
  if (DELIBERATE_REFUSALS.has(reason)) return null;
  if (reason !== "no_provider" && reason !== "consent_required") {
    return codeForRefusal(reason);
  }
  const pinned = await capabilityIsPinned(scope);
  if (pinned && reason === "no_provider") return "chain_no_provider";
  return pinned || scope.requested ? codeForRefusal(reason) : null;
}

async function apply(
  scope: AiJobScope,
  settled: Settled,
  durationMs: number,
): Promise<void> {
  switch (settled.state) {
    case "none":
      return;
    case "served":
      await clear(scope);
      return;
    case "failing": {
      const code = codeForProviderCalls(settled.calls);
      if (code) await persist(scope, code, settled.providerType, durationMs);
      return;
    }
    case "refused": {
      const code = await refusalCode(scope, settled.reason);
      if (code) await persist(scope, code, null, durationMs);
      return;
    }
    case "code":
      await persist(scope, settled.code, settled.providerType, durationMs);
  }
}

/** Fold the witness into one outcome per kind of work it saw. */
export function settleWitness(
  scope: AiJobScope,
  witness: AiJobWitness,
): Map<AiJobKind, Settled> {
  const own = AI_JOB_CAPABILITY[scope.job];
  const out = new Map<AiJobKind, Settled>();
  for (const event of witness.events) {
    if ("userId" in event && event.userId !== scope.userId) continue;
    const kind =
      event.capability === null || event.capability === own
        ? scope.job
        : CAPABILITY_JOB_KIND[event.capability];
    if (!kind) continue;
    const prior = out.get(kind) ?? { state: "none" };
    switch (event.type) {
      case "served":
        out.set(kind, { state: "served" });
        break;
      case "failed": {
        const call = {
          failure: event.failure,
          httpStatus: event.httpStatus,
        };
        out.set(kind, {
          state: "failing",
          calls: prior.state === "failing" ? [...prior.calls, call] : [call],
          providerType: event.providerType,
        });
        break;
      }
      case "refused":
        out.set(kind, {
          state: "refused",
          reason: event.reason,
          tentative: event.tentative,
        });
        break;
      case "admitted":
        if (prior.state === "refused" && prior.tentative) {
          out.set(kind, { state: "none" });
        }
        break;
      case "code":
        out.set(kind, {
          state: "code",
          code: event.code,
          providerType: event.providerType,
        });
    }
  }
  return out;
}

async function settle(
  scope: AiJobScope,
  witness: AiJobWitness,
  durationMs: number,
  thrown?: { error: unknown },
): Promise<void> {
  try {
    const outcomes = settleWitness(scope, witness);
    if (thrown && (outcomes.get(scope.job)?.state ?? "none") === "none") {
      const reason = refusalOf(thrown.error);
      const code = reason ? null : codeForProviderError(thrown.error);
      if (reason) {
        outcomes.set(scope.job, { state: "refused", reason, tentative: false });
      } else if (code === "no_provider") {
        outcomes.set(scope.job, {
          state: "refused",
          reason: "no_provider",
          tentative: false,
        });
      } else if (code) {
        outcomes.set(scope.job, { state: "code", code, providerType: null });
      }
    }
    for (const [job, settled] of outcomes) {
      await apply(
        job === scope.job ? scope : { userId: scope.userId, job },
        settled,
        durationMs,
      );
    }
  } catch (err) {
    logCaught("ai.job.failure_report_failed", err);
  }
}

/**
 * Run one job's work under a witness and record how it ended. The value or
 * the error of `fn` passes through unchanged.
 */
export async function trackAiJob<T>(
  scope: AiJobScope,
  fn: () => Promise<T>,
): Promise<T> {
  const witness: AiJobWitness = { events: [] };
  const startedAt = performance.now();
  let result: T;
  try {
    result = await withAiJobWitness(witness, fn);
  } catch (err) {
    await settle(scope, witness, performance.now() - startedAt, {
      error: err,
    });
    throw err;
  }
  await settle(scope, witness, performance.now() - startedAt);
  return result;
}

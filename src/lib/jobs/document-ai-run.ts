/**
 * The background document AI run: one model read a request handed off with
 * 202 instead of holding the connection open for it (v1.40).
 *
 * The route has already refused what it could refuse quickly (auth, module,
 * capability, provider, rate bucket, budget, a malformed upload) and sealed
 * the run's input into its `DocumentAiRun` row. This worker:
 *
 *   1. claims the row (QUEUED → RUNNING, a conditional update, so a second
 *      delivery does nothing);
 *   2. asks the capability again for the record (`aiCapabilityForJob`), picks
 *      the provider the way the route does and re-checks the wire for exactly
 *      that provider (`aiEgressRefusal`): consent may have been withdrawn or a
 *      switch turned off while the run waited;
 *   3. sets the run's deadline from the person's AI response time (one
 *      `callTimeoutMs` per model call the read can make) and refuses to start
 *      a read that would not fit inside the job's own expiry (`jobDeadline`);
 *   4. runs the same body the synchronous route runs, and stores the result
 *      or the failure the route would have answered with.
 *
 * The queue is `long` (`queue-runtime.ts`): a read at the longest response
 * setting outlasts pg-boss's fifteen-minute default. Each job runs under the
 * lock `lockedPass` takes per run, and is sent with `retryLimit: 0`: a run
 * the worker lost is failed by the reaper and asked for again by the person,
 * never re-run behind their back.
 *
 * The queue MUST be registered in the maintenance registrar
 * (`src/lib/jobs/reminder/register-maintenance.ts`) so pg-boss provisions it.
 */
import type { Job } from "pg-boss";

import { aiEgressRefusal } from "@/lib/ai/capabilities/egress";
import { aiCapabilityForJob } from "@/lib/ai/capabilities/gate";
import { AiUnavailableError } from "@/lib/ai/capabilities/refusal";
import {
  PICK_DECIDED_REASONS,
  type AiCapabilityKey,
} from "@/lib/ai/capabilities/types";
import { callTimeoutMs } from "@/lib/ai/effective-timeout";
import { prisma } from "@/lib/db";
import { loadOwnedDocument } from "@/lib/documents/ai-route-support";
import { loadDocumentChatText } from "@/lib/documents/content-index";
import { refusalAsFailure } from "@/lib/documents/ai-runs/http";
import {
  DOCUMENT_EXTRACT_MODEL_CALLS,
  executeDocumentExtract,
} from "@/lib/documents/ai-runs/extract-run";
import {
  DOCUMENT_INDEX_MODEL_CALLS,
  executeDocumentIndex,
} from "@/lib/documents/ai-runs/index-run";
import {
  DOCUMENT_SUGGEST_MODEL_CALLS,
  executeDocumentSuggest,
} from "@/lib/documents/ai-runs/suggest-run";
import {
  DOCUMENT_SUMMARY_MODEL_CALLS,
  executeDocumentSummary,
  markQueuedSummaryUnavailable,
} from "@/lib/documents/ai-runs/summary-run";
import {
  claimAiRun,
  completeAiRun,
  failAiRun,
  settleAiRunBudget,
  type AiRunFailure,
  type ClaimedAiRun,
} from "@/lib/documents/ai-runs/store";
import {
  AI_RUN_ERROR_CODES,
  AI_RUN_MARGIN_MS,
  DOCUMENT_AI_RUN_CAPABILITY,
  type AiRunBudget,
  type AiRunOutcome,
  type AiRunResult,
  type DocumentAiRunKindValue,
} from "@/lib/documents/ai-runs/types";
import {
  requireDocumentTextProvider,
  requireDocumentVisionProvider,
} from "@/lib/documents/provider-order";
import { coerceLocale } from "@/lib/i18n/config";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { jobDeadline } from "@/lib/jobs/job-budget";
import { jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";
import { requireLabsOcrProvider } from "@/lib/labs/ocr-capability";
import {
  executeOcrExtraction,
  OCR_EXTRACT_MODEL_CALLS,
} from "@/lib/labs/ocr-run";
import { annotate } from "@/lib/logging/context";
import { logCaught } from "@/lib/logging/signal";

export const DOCUMENT_AI_RUN_QUEUE = "document-ai-run";

/** Two reads at a time: provider calls, kept off the request pool. */
export const DOCUMENT_AI_RUN_CONCURRENCY = 2;

/**
 * The job's expiry: one hour. Three model calls at the longest response
 * setting (600 s) plus the document work fit inside the three quarters of it
 * `jobDeadline` allows; a read that would not is refused before it starts.
 */
export const DOCUMENT_AI_RUN_EXPIRE_SECONDS = 60 * 60;

export interface DocumentAiRunPayload {
  runId: string;
  userId: string;
}

/** The capability each kind of run answers to. */
const RUN_CAPABILITY = DOCUMENT_AI_RUN_CAPABILITY;

/**
 * Hand a created run to the worker. False when no queue is reachable; the
 * caller fails the run and answers 503 rather than leaving a run nobody
 * will pick up.
 */
export async function enqueueDocumentAiRun(
  runId: string,
  userId: string,
): Promise<boolean> {
  const boss = getGlobalBoss();
  if (!boss) return false;
  const payload: DocumentAiRunPayload = { runId, userId };
  try {
    const jobId = await boss.send(DOCUMENT_AI_RUN_QUEUE, payload, {
      retryLimit: 0,
      expireInSeconds: DOCUMENT_AI_RUN_EXPIRE_SECONDS,
    });
    return Boolean(jobId);
  } catch (err) {
    annotate({
      action: { name: "ai_runs.enqueue_failed" },
      meta: { reason: err instanceof Error ? err.name : "unknown" },
    });
    logCaught("ai_runs.enqueue_failed", err);
    return false;
  }
}

class RunRefused extends Error {
  constructor(readonly failure: AiRunFailure) {
    super(failure.errorCode);
  }
}

/** Refuse the run when the capability or the wire is closed for this provider. */
async function assertRunMayEgress(
  key: AiCapabilityKey,
  userId: string,
  providerTypes: readonly string[],
): Promise<void> {
  const state = await aiCapabilityForJob(userId, key);
  if (state.reason !== null && !PICK_DECIDED_REASONS.has(state.reason)) {
    throw new AiUnavailableError(key, state.reason);
  }
  const refusal = await aiEgressRefusal(key, userId, providerTypes);
  if (refusal) throw refusal;
}

/**
 * Set the deadline the reaper enforces from the person's response time, or
 * refuse a read that cannot finish inside the job's own expiry.
 */
async function armDeadline(
  runId: string,
  perCallMs: number,
  modelCalls: number,
  deadlineAt: number | undefined,
  now: () => number,
): Promise<void> {
  const ends = now() + perCallMs * modelCalls + AI_RUN_MARGIN_MS;
  if (deadlineAt !== undefined && ends > deadlineAt) {
    throw new RunRefused({
      status: 504,
      errorCode: AI_RUN_ERROR_CODES.timedOut,
      message:
        "The AI response time is set longer than a background read may run.",
    });
  }
  await prisma.documentAiRun.updateMany({
    where: { id: runId, status: "RUNNING" },
    data: { expiresAt: new Date(ends) },
  });
}

async function runDocumentIndex(
  run: ClaimedAiRun,
  deadlineAt: number | undefined,
  now: () => number,
): Promise<AiRunOutcome<AiRunResult>> {
  const document = run.documentId
    ? await loadOwnedDocument(run.userId, run.documentId)
    : null;
  if (!document) {
    await settleAiRunBudget(run.userId, run.params.budget, 0, null);
    return {
      ok: false,
      status: 404,
      message: "Document not found",
      errorCode: "documents.inbound.notFound",
    };
  }
  if (run.params.mode === "text") {
    // No transcription call, but the lab staging after the index is model
    // work (a read and its corrective retry) under the person's setting.
    const owner = await prisma.user.findUnique({
      where: { id: run.userId },
      select: { aiResponseTimeoutSeconds: true },
    });
    await armDeadline(
      run.id,
      callTimeoutMs({}, owner?.aiResponseTimeoutSeconds ?? null),
      DOCUMENT_INDEX_MODEL_CALLS - 1,
      deadlineAt,
      now,
    );
    return executeDocumentIndex({
      userId: run.userId,
      document,
      input: { mode: "text", text: run.input?.toString("utf8") ?? "" },
      origin: { ipAddress: null, worker: true },
    });
  }
  const pick = await requireDocumentVisionProvider(run.userId);
  await assertRunMayEgress("documentAi", run.userId, [pick.providerType]);
  await armDeadline(
    run.id,
    callTimeoutMs({}, pick.entry.instance.responseTimeoutSeconds),
    DOCUMENT_INDEX_MODEL_CALLS,
    deadlineAt,
    now,
  );
  if (!run.params.budget) throw new Error("vision run without a reservation");
  return executeDocumentIndex({
    userId: run.userId,
    document,
    input: { mode: "vision", pick, budget: run.params.budget },
    origin: { ipAddress: null, worker: true },
  });
}

async function runLabsOcr(
  run: ClaimedAiRun,
  deadlineAt: number | undefined,
  now: () => number,
): Promise<AiRunOutcome<AiRunResult>> {
  if (!run.input) throw new Error("lab scan run without an input");
  if (run.params.mode === "text") {
    const pick = await requireLabsOcrProvider(run.userId, "text");
    await assertRunMayEgress("labsOcr", run.userId, [pick.providerType]);
    await armDeadline(
      run.id,
      callTimeoutMs({}, pick.entry.instance.responseTimeoutSeconds),
      OCR_EXTRACT_MODEL_CALLS,
      deadlineAt,
      now,
    );
    return executeOcrExtraction({
      userId: run.userId,
      budget: run.params.budget,
      input: { mode: "text", text: run.input.toString("utf8"), pick },
    });
  }
  const mime = run.params.mime;
  if (!mime) throw new Error("lab scan run without a MIME type");
  const pick = await requireLabsOcrProvider(run.userId, "vision");
  await assertRunMayEgress("labsOcr", run.userId, [pick.providerType]);
  await armDeadline(
    run.id,
    callTimeoutMs({}, pick.entry.instance.responseTimeoutSeconds),
    OCR_EXTRACT_MODEL_CALLS,
    deadlineAt,
    now,
  );
  return executeOcrExtraction({
    userId: run.userId,
    budget: run.params.budget,
    input: { mode: "vision", bytes: run.input, mime, pick },
  });
}

/** The owned document a run reads, or the route's own 404 when it is gone. */
async function loadRunDocument(run: ClaimedAiRun) {
  const document = run.documentId
    ? await loadOwnedDocument(run.userId, run.documentId)
    : null;
  if (document) return document;
  // The reservation goes back in `runDocumentAiRun`'s catch.
  throw new RunRefused({
    status: 404,
    message: "Document not found",
    errorCode: "documents.inbound.notFound",
  });
}

/** The reservation a provider read was queued with. */
function runBudget(run: ClaimedAiRun): AiRunBudget {
  if (!run.params.budget)
    throw new Error("document read without a reservation");
  return run.params.budget;
}

/**
 * Pick the provider for a document read the way its route does, re-check the
 * capability and the wire for exactly that provider, and arm the deadline for
 * the calls the read can make.
 */
async function pickForDocumentRead(
  run: ClaimedAiRun,
  modelCalls: number,
  deadlineAt: number | undefined,
  now: () => number,
) {
  if (run.params.mode === "text") {
    const pick = await requireDocumentTextProvider(run.userId);
    await assertRunMayEgress("documentAi", run.userId, [pick.providerType]);
    await armDeadline(
      run.id,
      callTimeoutMs({}, pick.entry.instance.responseTimeoutSeconds),
      modelCalls,
      deadlineAt,
      now,
    );
    return { mode: "text" as const, pick };
  }
  const pick = await requireDocumentVisionProvider(run.userId);
  await assertRunMayEgress("documentAi", run.userId, [pick.providerType]);
  await armDeadline(
    run.id,
    callTimeoutMs({}, pick.entry.instance.responseTimeoutSeconds),
    modelCalls,
    deadlineAt,
    now,
  );
  return { mode: "vision" as const, pick };
}

/** The text the browser read, sealed into the run by the queuing route. */
function runText(run: ClaimedAiRun): string {
  if (!run.input) throw new Error("text read without an input");
  return run.input.toString("utf8");
}

async function runDocumentSummaryRead(
  run: ClaimedAiRun,
  deadlineAt: number | undefined,
  now: () => number,
): Promise<AiRunOutcome<AiRunResult>> {
  const options = run.params.summary;
  if (!options) throw new Error("summary run without its options");
  const document = await loadRunDocument(run);
  const read = await pickForDocumentRead(
    run,
    DOCUMENT_SUMMARY_MODEL_CALLS,
    deadlineAt,
    now,
  );
  const budget = runBudget(run);
  return executeDocumentSummary({
    userId: run.userId,
    document,
    input:
      read.mode === "text"
        ? { mode: "text", text: runText(run), pick: read.pick, budget }
        : { mode: "vision", pick: read.pick, budget },
    output: options.output,
    locale: coerceLocale(options.locale),
    persist: options.persist ? { replaceExisting: options.replace } : null,
    origin: { ipAddress: null, worker: true },
  });
}

async function runDocumentSuggestRead(
  run: ClaimedAiRun,
  deadlineAt: number | undefined,
  now: () => number,
): Promise<AiRunOutcome<AiRunResult>> {
  const document = await loadRunDocument(run);
  const read = await pickForDocumentRead(
    run,
    DOCUMENT_SUGGEST_MODEL_CALLS,
    deadlineAt,
    now,
  );
  const budget = runBudget(run);
  return executeDocumentSuggest({
    userId: run.userId,
    document,
    input:
      read.mode === "text"
        ? { mode: "text", text: runText(run), pick: read.pick, budget }
        : { mode: "vision", pick: read.pick, budget },
    origin: { ipAddress: null, worker: true },
  });
}

/** The text an extract run structures: the sealed browser text, or the content index. */
async function extractText(run: ClaimedAiRun): Promise<string> {
  if (run.params.extract?.input !== "stored") return runText(run);
  const chat = run.documentId
    ? await loadDocumentChatText(run.userId, run.documentId)
    : null;
  if (!chat || !chat.text.trim()) {
    throw new RunRefused({
      status: 422,
      message: "Read the document first, then extract.",
      errorCode: "documents.inbound.notIndexed",
    });
  }
  return chat.text;
}

async function runDocumentExtractRead(
  run: ClaimedAiRun,
  deadlineAt: number | undefined,
  now: () => number,
): Promise<AiRunOutcome<AiRunResult>> {
  const document = await loadRunDocument(run);
  const text = run.params.mode === "text" ? await extractText(run) : null;
  const read = await pickForDocumentRead(
    run,
    DOCUMENT_EXTRACT_MODEL_CALLS,
    deadlineAt,
    now,
  );
  const budget = runBudget(run);
  const outcome = await executeDocumentExtract({
    userId: run.userId,
    document,
    input:
      read.mode === "text"
        ? {
            mode: run.params.extract?.input === "stored" ? "stored" : "text",
            text: text ?? "",
            pick: read.pick,
            budget,
          }
        : { mode: "vision", pick: read.pick, budget },
    origin: { ipAddress: null, worker: true },
  });
  if (!outcome.ok) return outcome;
  // The facts are staged on the document; the run carries only the count.
  return {
    ok: true,
    data: {
      documentId: outcome.data.id,
      factsStaged: outcome.data.facts.length,
      status: outcome.data.status,
    },
  };
}

type RunDispatcher = (
  run: ClaimedAiRun,
  deadlineAt: number | undefined,
  now: () => number,
) => Promise<AiRunOutcome<AiRunResult>>;

/**
 * The body each kind of run executes. Every dispatcher that sends anything to
 * a model re-checks the capability and the wire for its provider first
 * (`assertRunMayEgress`); `ai-egress-capability-guard.test.ts` holds that.
 */
const RUN_DISPATCH: Record<DocumentAiRunKindValue, RunDispatcher> = {
  DOCUMENT_INDEX: runDocumentIndex,
  LABS_OCR_EXTRACT: runLabsOcr,
  DOCUMENT_SUMMARY: runDocumentSummaryRead,
  DOCUMENT_SUGGEST: runDocumentSuggestRead,
  DOCUMENT_EXTRACT: runDocumentExtractRead,
};

/**
 * What a failed run leaves behind besides itself. A summary that was to be
 * stored had its document marked PENDING at enqueue; a failure says it could
 * not be produced rather than leaving "being prepared" until the hourly
 * reaper notices.
 */
async function afterRunFailed(run: ClaimedAiRun): Promise<void> {
  if (
    run.kind === "DOCUMENT_SUMMARY" &&
    run.params.summary?.persist &&
    run.documentId
  ) {
    await markQueuedSummaryUnavailable(run.userId, run.documentId);
  }
}

export type DocumentAiRunResult = "succeeded" | "failed" | "skipped";

/**
 * Run one queued run to its end. `deadlineAt` is the instant the job's own
 * expiry allows work until (`jobDeadline`); `now` is injectable for tests.
 */
export async function runDocumentAiRun(
  runId: string,
  deadlineAt: number | undefined,
  now: () => number = Date.now,
): Promise<DocumentAiRunResult> {
  const provisional = new Date(
    deadlineAt ?? now() + DOCUMENT_AI_RUN_EXPIRE_SECONDS * 1000,
  );
  const run = await claimAiRun(runId, provisional, new Date(now()));
  if (!run) return "skipped";

  let outcome: AiRunOutcome<AiRunResult>;
  try {
    outcome = await RUN_DISPATCH[run.kind](run, deadlineAt, now);
  } catch (err) {
    // Everything that throws here threw before the body took over the
    // reservation, so it goes back here.
    await settleAiRunBudget(run.userId, run.params.budget, 0, null);
    const failure: AiRunFailure = (err instanceof RunRefused
      ? err.failure
      : null) ??
      refusalAsFailure(err) ?? {
        status: 500,
        errorCode: AI_RUN_ERROR_CODES.failed,
        message: "The background read failed.",
      };
    await failAiRun(run.id, failure, "RUNNING", new Date(now()));
    await afterRunFailed(run);
    annotate({
      action: { name: "ai_runs.failed" },
      meta: {
        kind: run.kind,
        capability: RUN_CAPABILITY[run.kind],
        errorCode: failure.errorCode,
      },
    });
    return "failed";
  }

  if (outcome.ok) {
    await completeAiRun(run.id, outcome.data, new Date(now()));
    if (
      "persistence" in outcome.data &&
      outcome.data.persistence === "failed"
    ) {
      // The summary was read but could not be stored on the document.
      await afterRunFailed(run);
    }
    annotate({
      action: { name: "ai_runs.succeeded" },
      meta: { kind: run.kind },
    });
    return "succeeded";
  }
  await failAiRun(
    run.id,
    {
      status: outcome.status,
      errorCode: outcome.errorCode,
      message: outcome.message,
    },
    "RUNNING",
    new Date(now()),
  );
  await afterRunFailed(run);
  annotate({
    action: { name: "ai_runs.failed" },
    meta: { kind: run.kind, errorCode: outcome.errorCode },
  });
  return "failed";
}

/** The pg-boss handler; bound under `lockedPass` keyed by run id. */
export async function handleDocumentAiRunJobs(
  jobs: Job<DocumentAiRunPayload>[],
): Promise<JobOutcome> {
  let processed = 0;
  let failed = 0;
  let skipped = 0;
  for (const job of jobs) {
    const runId = job.data?.runId;
    if (!runId) {
      skipped += 1;
      continue;
    }
    const result = await runDocumentAiRun(runId, jobDeadline(job));
    if (result === "succeeded") processed += 1;
    else if (result === "failed") failed += 1;
    else skipped += 1;
  }
  return jobDone({ jobs: jobs.length, processed, failed, skipped });
}

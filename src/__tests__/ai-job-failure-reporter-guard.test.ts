/**
 * #1404 — every background AI job routes its failures through the one
 * reporter, so a stopped job cannot go silent again.
 *
 * The class: a job asks its capability (`aiCapabilityForJob`), calls a model,
 * and on a refusal or a provider error falls back or skips. The person saw
 * nothing; the reason lived in a log line. The reporter
 * (`src/lib/ai/job-failure/report.ts`) records it, but only for work that
 * runs inside `trackAiJob`, and only from what the shared places note on the
 * witness. So this file freezes both ends:
 *
 *   1. Every module under `src/lib/jobs/` (and the Coach memory worker) that
 *      calls `aiCapabilityForJob` is in `JOBS`, which names the file that
 *      wraps its entry point in `trackAiJob`, or in `EXEMPT` with the reason
 *      it records nothing of its own. A new AI job without an entry fails.
 *   2. Each wrapper really calls `trackAiJob` around that entry point.
 *   3. The shared places note on the witness: every provider call
 *      (`logChainCalls`), every worker capability read (`aiCapabilityForJob`)
 *      and the exact answer for a pick (`aiEgressRefusal`).
 *   4. Nothing but the reporter writes the table, so a second writer cannot
 *      store a message or a payload beside the closed codes.
 *   5. The matchers find what they judge: non-zero counts.
 *
 * What it does NOT prove: that a job's failure reaches the person. The
 * integration file `tests/integration/ai-job-failures.test.ts` proves that,
 * end to end, for the document summary and a cron job.
 */
import { describe, expect, it } from "vitest";

import {
  readSource,
  readSourceFolder,
  stripComments,
} from "./helpers/source-files";

/** A file under `src/`, comments out, anchored on what this guard watches. */
function code(rel: string, anchor: string | RegExp = "trackAiJob"): string {
  return stripComments(readSource(`src/${rel}`, anchor));
}

const LIB = readSourceFolder("src/lib", {
  floor: 1000,
  include: (rel) => !rel.includes("__tests__") && !/\.test\.tsx?$/.test(rel),
}).map(([rel, text]) => [`lib/${rel}`, stripComments(text)] as const);

/** Job module → the file that wraps its entry point, and that entry point. */
const JOBS: Record<string, { wrapper: string; entry: string }> = {
  "lib/jobs/document-summary.ts": {
    wrapper: "lib/jobs/reminder/document-handlers.ts",
    entry: "runDocumentSummaryJob",
  },
  "lib/jobs/document-content-index-backfill.ts": {
    wrapper: "lib/jobs/reminder/document-handlers.ts",
    entry: "runContentIndexBackfillForUser",
  },
  "lib/jobs/document-ai-run.ts": {
    wrapper: "lib/jobs/document-ai-run.ts",
    entry: "RUN_DISPATCH",
  },
  "lib/jobs/insight-status-generate.ts": {
    wrapper: "lib/jobs/reminder/insights-handlers.ts",
    entry: "runInsightStatusGenerate",
  },
  "lib/jobs/insight-pregenerate.ts": {
    wrapper: "lib/jobs/insight-pregenerate-scope.ts",
    entry: "fn",
  },
  "lib/jobs/period-narrative-warm.ts": {
    wrapper: "lib/jobs/period-narrative-warm.ts",
    entry: "generate",
  },
  "lib/jobs/workout-insight-generate.ts": {
    wrapper: "lib/jobs/workout-insight-generate.ts",
    entry: "runWorkoutInsightGenerate",
  },
  "lib/jobs/reaction-line.ts": {
    wrapper: "lib/jobs/reaction-line.ts",
    entry: "runReactionLine",
  },
  "lib/jobs/coach-nudge-ai.ts": {
    wrapper: "lib/jobs/coach-nudge-ai.ts",
    entry: "composeNudge",
  },
  "lib/ai/coach/coach-memory-refresh-worker.ts": {
    wrapper: "lib/jobs/reminder/status-handlers.ts",
    entry: "runCoachMemoryRefresh",
  },
};

/** Further wrappers the jobs above are entered through. */
const EXTRA_WRAPPERS: Array<{ wrapper: string; entry: string }> = [
  // The single-user forced warm, beside the nightly pass.
  { wrapper: "lib/jobs/reminder/insights-handlers.ts", entry: "forceWarmUser" },
  // The 02:00 status batch.
  {
    wrapper: "lib/jobs/reminder/insights-handlers.ts",
    entry: "generateStatusBatchForUser",
  },
  // The per-document index on upload.
  {
    wrapper: "lib/jobs/reminder/document-handlers.ts",
    entry: "runDocumentIndex",
  },
  // The single-user narrative warm.
  {
    wrapper: "lib/jobs/reminder/status-handlers.ts",
    entry: "warmOneNarrative",
  },
];

/** Callers that record nothing of their own, and why. */
const EXEMPT: Record<string, string> = {
  "lib/jobs/document-summary-catchup.ts":
    "Enqueues one summary job per document and skips only on a switch that is somebody's decision; each summary job it enqueues is tracked.",
  "lib/jobs/coach-nudge.ts":
    "The tick's gate drops a record whose Coach cannot answer before any work; the AI composition it hands to (`coach-nudge-ai.ts`) is tracked, and a nudge always goes out as its template.",
};

function callers(): string[] {
  return LIB.filter(
    ([rel]) =>
      rel.startsWith("lib/jobs/") ||
      rel === "lib/ai/coach/coach-memory-refresh-worker.ts",
  )
    .filter(([, text]) => /\baiCapabilityForJob\s*\(/.test(text))
    .map(([rel]) => rel)
    .sort();
}

/** `trackAiJob(` followed, within the call, by the entry point's name. */
function wraps(source: string, entry: string): boolean {
  const re = new RegExp(`\\btrackAiJob\\s*\\([\\s\\S]{0,600}?\\b${entry}\\b`);
  return re.test(source);
}

describe("background AI jobs and the failure reporter", () => {
  it("lists every job that asks a capability", () => {
    const found = callers();
    expect(found.length).toBeGreaterThanOrEqual(10);
    const unlisted = found.filter((rel) => !(rel in JOBS) && !(rel in EXEMPT));
    expect(
      unlisted,
      "A background job asks an AI capability without routing its failures through `trackAiJob`. Wrap its entry point and list it in JOBS, or say in EXEMPT why it records nothing.",
    ).toEqual([]);
    const stale = [...Object.keys(JOBS), ...Object.keys(EXEMPT)].filter(
      (rel) => !found.includes(rel),
    );
    expect(stale, "Listed but no longer a caller").toEqual([]);
  });

  it("wraps each entry point in trackAiJob", () => {
    const pairs = [...Object.values(JOBS), ...EXTRA_WRAPPERS];
    expect(pairs.length).toBeGreaterThanOrEqual(14);
    const missing = pairs
      .filter(({ wrapper, entry }) => !wraps(code(wrapper), entry))
      .map(({ wrapper, entry }) => `${wrapper} :: ${entry}`);
    expect(missing).toEqual([]);
    // The nightly pregenerate enters each candidate through its scope.
    expect(code("lib/jobs/insight-pregenerate.ts", "warmScope")).toMatch(
      /\bwarmScope\s*\(\s*candidate\.id\b/,
    );
  });

  it("is told by the shared places", () => {
    const chain = code("lib/ai/chain-call-log.ts", "noteAiJobEvent");
    expect(chain.match(/\bnoteAiJobEvent\s*\(/g)?.length).toBe(2);
    expect(chain).toMatch(/type:\s*"served"/);
    expect(chain).toMatch(/type:\s*"failed"/);

    const gate = code("lib/ai/capabilities/gate.ts", "noteAiJobEvent");
    expect(gate).toMatch(
      /export async function aiCapabilityForJob[\s\S]{0,400}?noteAiJobEvent\s*\(/,
    );
    const egress = code("lib/ai/capabilities/egress.ts", "noteAiJobEvent");
    expect(egress).toMatch(
      /export async function aiEgressRefusal[\s\S]{0,600}?noteAiJobEvent\s*\(/,
    );
  });

  it("has one writer", () => {
    const files = readSourceFolder("src", {
      floor: 3000,
      include: (rel) =>
        !rel.startsWith("generated/") &&
        !rel.includes("__tests__") &&
        !/\.test\.tsx?$/.test(rel),
    });
    const write =
      /\baiJobFailure\s*\.\s*(create|createMany|upsert|update|updateMany)\s*\(/;
    const writers = files
      .filter(([, text]) => write.test(stripComments(text)))
      .map(([rel]) => rel);
    expect(writers).toEqual(["lib/ai/job-failure/report.ts"]);
  });
});

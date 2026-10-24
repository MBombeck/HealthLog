/**
 * Structural guard: no job that waits on the person's response timeout can
 * outlive its pg-boss expiry.
 *
 * Every model call has the record owner's response timeout to itself, up to
 * ten minutes (`AI_RESPONSE_TIMEOUT_MAX_SECONDS`). pg-boss fails a job that
 * runs past its expiry (fifteen minutes unless the send says otherwise) and
 * retries it while the handler keeps going. The morning refresh is one
 * comprehensive generation of up to five calls in a row, so under a large
 * setting it was retried beside itself (#1274); the per-metric note, the
 * workout line and the Coach memory pass could each do the same once a status
 * run waited for its reasoning repeat.
 *
 * The entry points that carry a background model run at the person's
 * timeout: `runStatusCompletion` (a status run, `STATUS_MODEL_CALLS` calls),
 * `generateComprehensiveInsight` (`COMPREHENSIVE_MODEL_CALLS` calls), and the
 * document and lab reads: `runOcrReads` (a report's reads, as many as the
 * run's deadline allows, or up to `OCR_MAX_PAGES` without one),
 * `transcribeDocument`, `runDocumentSummary`, `runDocumentAssist` and
 * `executeSupplementLabelExtraction`. The guard holds:
 *
 *   1. every file that imports one of them is named below with the queues
 *      whose jobs reach it, or as a request surface with its reason, so a new
 *      caller has to be attributed;
 *   2. each of those queues is `bounded` in `queue-runtime.ts`, with model
 *      time at least the runs it makes at the largest setting and an expiry
 *      above that, or `long`, where the run's lock makes the retry after an
 *      overrun report `already_running` instead of working beside it;
 *   3. a queue declared `short` cannot be one of them.
 *
 * Its limit: the run counts per queue are declared here, not derived; the
 * Coach memory refresh's three runs, for instance, are three calls in
 * `runCoachMemoryRefresh` that a reader has to count. A `long` queue is held
 * to its lock, not to arithmetic: its reads are planned against the job's
 * deadline (`jobDeadline`), which `document-index.test.ts` and the document
 * run's own tests prove. Model calls outside these entry points (the
 * reaction line and the nudge, both under a fixed surface ceiling) are not
 * covered here.
 *
 * Mutation check: declare `morning-digest-refresh` or `document-index` short
 * again, drop a run from a queue's model time, or import `runStatusCompletion`
 * or `runOcrReads` into a new file, and this goes red. The "plants" case runs the check over the table as it
 * stood before #1274.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";
import { QUEUE_RUNTIME, type QueueRuntime } from "@/lib/jobs/queue-runtime";
import {
  COMPLETION_CEILING_MS,
  COMPREHENSIVE_WARM_CEILING_MS,
  STATUS_RUN_CEILING_MS,
} from "@/lib/jobs/model-time";
import {
  COMPREHENSIVE_MODEL_CALLS,
  STATUS_MODEL_CALLS,
} from "@/lib/ai/ai-budgets";
import { AI_RESPONSE_TIMEOUT_MAX_SECONDS } from "@/lib/ai/effective-timeout";

const SRC = join(process.cwd(), "src");
const ENTRY_POINTS = [
  "runStatusCompletion",
  "generateComprehensiveInsight",
  "runOcrReads",
  "transcribeDocument",
  "runDocumentSummary",
  "runDocumentAssist",
  "executeSupplementLabelExtraction",
];

/** Each importer of an entry point, and the queues whose jobs reach it. */
const MODEL_RUN_SITES: Readonly<Record<string, readonly string[]>> = {
  "lib/insights/status-card-generation.ts": [
    "insight-status-generate",
    "insights-general-status",
    "insight-pregenerate",
  ],
  "lib/insights/derived/derived-assessment-ai.ts": ["insight-status-generate"],
  "lib/insights/status-batch.ts": [
    "insights-general-status",
    "insight-pregenerate",
  ],
  "lib/insights/narrative/period-narrative-generate.ts": [
    "period-narrative-warm",
  ],
  "lib/ai/coach/conversation-summary.ts": ["coach-memory-refresh"],
  "lib/ai/coach/facts.ts": ["coach-memory-refresh"],
  "lib/ai/coach/plans.ts": ["coach-memory-refresh"],
  "lib/jobs/workout-insight-generate.ts": ["workout-insight-generate"],
  "lib/jobs/insight-pregenerate.ts": ["insight-pregenerate"],
  "lib/jobs/morning-digest-refresh.ts": ["morning-digest-refresh"],
  "lib/documents/extract.ts": ["document-ai-run", "document-index"],
  "lib/documents/index-document.ts": ["document-index", "document-ai-run"],
  "lib/documents/ai-runs/index-run.ts": ["document-ai-run"],
  "lib/documents/ai-runs/summary-run.ts": ["document-ai-run"],
  "lib/documents/ai-runs/suggest-run.ts": ["document-ai-run"],
  "lib/labs/ocr-extract.ts": ["document-ai-run"],
  "lib/jobs/document-ai-run.ts": ["document-ai-run"],
  "lib/jobs/document-content-index-backfill.ts": [
    "document-content-index-backfill",
  ],
  "lib/jobs/document-summary.ts": ["document-summary"],
};

/**
 * Importers no queue reaches: a request waits on them, and the browser's
 * abort follows the published setting (`clientAbortMs`).
 */
const REQUEST_SITES: Readonly<Record<string, string>> = {
  "app/api/documents/inbound/[id]/summary/route.ts":
    "The on-demand transcription a person asked for; the background path runs through document-ai-run.",
};

/** What one job of a bounded queue runs, at most, one after another. */
const RUNS: Readonly<
  Record<
    string,
    {
      status?: number;
      comprehensive?: number;
      completions?: number;
      why: string;
    }
  >
> = {
  "insight-status-generate": {
    status: 1,
    why: "Each scope's generator makes one status run (runPreparedStatusCard or the derived assessment).",
  },
  "workout-insight-generate": {
    status: 1,
    why: "One status run behind the provider claim.",
  },
  "coach-memory-refresh": {
    status: 3,
    why: "The summary, the facts and the plan proposals, one run each, in a row.",
  },
  "morning-digest-refresh": {
    comprehensive: 1,
    why: "One forced comprehensive generation.",
  },
  "document-summary": {
    completions: 1,
    why: "One summary call (DOCUMENT_SUMMARY_MODEL_CALLS) and its reasoning repeat.",
  },
};

/** Value specifiers of every `import { … } from` in `text`. */
function importedNames(text: string): string[] {
  return [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']+["']/g)]
    .flatMap((m) => m[1].split(","))
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && !name.startsWith("type "))
    .map((name) => name.split(/\s+as\s+/)[0]);
}

function importers(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .filter((rel) =>
      importedNames(stripComments(readSourceText(join(SRC, rel)))).some(
        (name) => ENTRY_POINTS.includes(name),
      ),
    )
    .sort();
}

/** Seconds of model work `runs` makes at the largest setting. */
function modelSecondsOf(runs: {
  status?: number;
  comprehensive?: number;
  completions?: number;
}) {
  return (
    ((runs.status ?? 0) * STATUS_RUN_CEILING_MS +
      (runs.comprehensive ?? 0) * COMPREHENSIVE_WARM_CEILING_MS +
      (runs.completions ?? 0) * COMPLETION_CEILING_MS) /
    1000
  );
}

/** Every finding for the queues that reach a model run. */
function findings(table: Readonly<Record<string, QueueRuntime>>): string[] {
  const queues = [...new Set(Object.values(MODEL_RUN_SITES).flat())].sort();
  const problems: string[] = [];
  for (const queue of queues) {
    const entry = table[queue];
    if (!entry) {
      problems.push(`${queue}: not in QUEUE_RUNTIME`);
      continue;
    }
    if (entry.runtime === "long") {
      if (entry.exclusive !== "lockedPass") {
        problems.push(`${queue}: long without the run lock`);
      }
      continue;
    }
    if (entry.runtime !== "bounded") {
      problems.push(
        `${queue}: declared ${entry.runtime}, but it waits on the person's response timeout`,
      );
      continue;
    }
    const runs = RUNS[queue];
    if (!runs) {
      problems.push(`${queue}: bounded without its runs named here`);
      continue;
    }
    const needed = modelSecondsOf(runs);
    if (entry.modelSeconds < needed) {
      problems.push(
        `${queue}: model time ${entry.modelSeconds}s below the ${needed}s its runs take`,
      );
    }
    if (!(entry.expireInSeconds > entry.modelSeconds)) {
      problems.push(`${queue}: expiry not above its model time`);
    }
  }
  return problems;
}

describe("jobs that wait on the response timeout outlast it", () => {
  it("names every importer of a model run (an empty set is a failure)", () => {
    const found = importers();
    expect(found.length).toBeGreaterThanOrEqual(20);
    expect(found).toEqual(
      [...Object.keys(MODEL_RUN_SITES), ...Object.keys(REQUEST_SITES)].sort(),
    );
  });

  it("sizes the run ceilings from the largest setting and the call counts", () => {
    expect(STATUS_RUN_CEILING_MS).toBe(
      AI_RESPONSE_TIMEOUT_MAX_SECONDS * 1000 * STATUS_MODEL_CALLS,
    );
    expect(COMPREHENSIVE_WARM_CEILING_MS).toBeGreaterThan(
      AI_RESPONSE_TIMEOUT_MAX_SECONDS * 1000 * COMPREHENSIVE_MODEL_CALLS,
    );
  });

  it("every queue that reaches a model run is bounded above it or locked", () => {
    expect(findings(QUEUE_RUNTIME)).toEqual([]);
  });

  it("names its runs only for queues that are bounded", () => {
    expect(
      Object.keys(RUNS).filter((q) => QUEUE_RUNTIME[q]?.runtime !== "bounded"),
    ).toEqual([]);
  });

  it("names every request surface with a reason, and none twice", () => {
    for (const [rel, why] of Object.entries(REQUEST_SITES)) {
      expect(why.length, rel).toBeGreaterThan(30);
      expect(rel in MODEL_RUN_SITES, rel).toBe(false);
    }
  });

  it("plants: the table before #1274 is caught", () => {
    const before: Record<string, QueueRuntime> = {
      ...QUEUE_RUNTIME,
      "morning-digest-refresh": {
        runtime: "short",
        why: "One account, one comprehensive generation, bounded by the provider timeout.",
      },
      "coach-memory-refresh": {
        runtime: "bounded",
        modelSeconds: STATUS_RUN_CEILING_MS / 1000,
        expireInSeconds: 1400,
        expiryVia: [],
        why: "planted: one run counted instead of three",
      },
    };
    expect(findings(before)).toEqual([
      `coach-memory-refresh: model time ${STATUS_RUN_CEILING_MS / 1000}s below the ${modelSecondsOf({ status: 3 })}s its runs take`,
      "morning-digest-refresh: declared short, but it waits on the person's response timeout",
    ]);
  });
});

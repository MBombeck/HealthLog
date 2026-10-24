/**
 * Structural guard (#1279): every queue whose jobs reach a model retries a
 * bounded number of times, with a backoff, never in a tight loop.
 *
 * pg-boss gives a send that names no retry options the queue's defaults:
 * two retries, no delay, no backoff. A job that reaches a model and fails is
 * then run again at once, twice, against a provider that just failed. So
 * every place a job for such a queue is created says what it wants: each
 * `send` names `retryLimit` (at most `MAX_RETRY_LIMIT`), and unless that is
 * 0, `retryBackoff: true` and a `retryDelay` of at least `MIN_RETRY_DELAY_S`
 * seconds; each cron carries the same in its schedule options.
 *
 * The queues are the ones `MODEL_RUN_SITES` attributes to a model-run entry
 * point (complete by `ai-job-expiry-guard.test.ts`), plus the queues whose
 * jobs call a provider instance directly (`DIRECT_CALL_QUEUES`), which this
 * guard keeps complete: every file under `lib/jobs` that calls
 * `generateCompletion` must be named there.
 *
 * Its limit: a `send` whose options come from a variable rather than an
 * object literal at the call is reported, not resolved; write the literal.
 * The bound on what one failure costs a record is elsewhere (the status
 * note's growing window, the chain's bench for background work); this guard
 * holds the queue layer.
 *
 * Mutation check: drop `retryBackoff` from a send in the set, raise a
 * `retryLimit` above three, remove a cron's schedule options, or call
 * `generateCompletion` from a new job file, and this goes red. The "plants"
 * case runs the checker over sources shaped like the tree before #1279.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";
import { MODEL_RUN_SITES } from "./helpers/model-run-sites";
import { allJobDefinitions } from "@/lib/jobs/registry";

const SRC = join(process.cwd(), "src");

/** The most retries a model-bound job may ask for. */
const MAX_RETRY_LIMIT = 3;

/** The least first retry delay, in seconds, when a job retries at all. */
const MIN_RETRY_DELAY_S = 30;

/** Job files that call a provider instance directly, and their queue. */
const DIRECT_CALL_QUEUES: Readonly<Record<string, string>> = {
  "lib/jobs/reaction-line.ts": "reaction-line-generate",
  "lib/jobs/coach-nudge-ai.ts": "coach-nudge",
};

function modelQueues(): string[] {
  return [
    ...new Set([
      ...Object.values(MODEL_RUN_SITES).flat(),
      ...Object.values(DIRECT_CALL_QUEUES),
    ]),
  ].sort();
}

interface SourceFile {
  rel: string;
  text: string;
}

function sources(): SourceFile[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .filter((p) => p.endsWith(".ts"))
    .map((rel) => ({
      rel,
      text: stripComments(readSourceText(join(SRC, rel))),
    }));
}

/** `export const NAME = "queue"` declarations: constant name → queue. */
function queueConstants(files: readonly SourceFile[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const { text } of files) {
    for (const m of text.matchAll(
      /export const ([A-Z][A-Z0-9_]*_QUEUE)\s*=\s*"([^"]+)"/g,
    )) {
      out.set(m[1], m[2]);
    }
  }
  return out;
}

/** The text of the call whose `(` sits at `open`, parentheses balanced. */
function callText(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

/** What is wrong with one set of retry options, or `null`. */
function retryProblem(options: {
  retryLimit?: unknown;
  retryDelay?: unknown;
  retryBackoff?: unknown;
}): string | null {
  const limit = options.retryLimit;
  if (typeof limit !== "number") return "names no retryLimit";
  if (limit > MAX_RETRY_LIMIT)
    return `retryLimit ${limit} above ${MAX_RETRY_LIMIT}`;
  if (limit === 0) return null;
  if (options.retryBackoff !== true) return "retries without retryBackoff";
  const delay = options.retryDelay;
  if (typeof delay !== "number" || delay < MIN_RETRY_DELAY_S) {
    return `retryDelay below ${MIN_RETRY_DELAY_S}s`;
  }
  return null;
}

/** The retry options an object literal in `call` spells out. */
function literalRetryOptions(call: string) {
  const num = (key: string) => {
    const m = new RegExp(`\\b${key}:\\s*(\\d+)`).exec(call);
    return m ? Number(m[1]) : undefined;
  };
  const backoff = /\bretryBackoff:\s*(true|false)/.exec(call);
  return {
    retryLimit: num("retryLimit"),
    retryDelay: num("retryDelay"),
    retryBackoff: backoff ? backoff[1] === "true" : undefined,
  };
}

/** Every send to a model-bound queue whose retry options fall short. */
function sendFindings(files: readonly SourceFile[], queues: readonly string[]) {
  const constants = queueConstants(files);
  const wanted = new Set(queues);
  const problems: string[] = [];
  let sends = 0;
  for (const { rel, text } of files) {
    for (const m of text.matchAll(/\.send(?:After)?\(\s*([A-Z][A-Z0-9_]*)/g)) {
      const queue = constants.get(m[1]);
      if (!queue || !wanted.has(queue)) continue;
      sends += 1;
      const open = text.indexOf("(", m.index);
      const problem = retryProblem(literalRetryOptions(callText(text, open)));
      if (problem) problems.push(`${rel}: send to ${queue} ${problem}`);
    }
  }
  return { problems, sends };
}

/** Every cron of a model-bound queue whose schedule options fall short. */
function cronFindings(
  jobs: ReadonlyArray<{
    queue: string;
    cron?: string;
    scheduleOptions?: Readonly<Record<string, unknown>>;
  }>,
  queues: readonly string[],
) {
  const wanted = new Set(queues);
  const problems: string[] = [];
  for (const job of jobs) {
    if (!job.cron || !wanted.has(job.queue)) continue;
    const problem = retryProblem(job.scheduleOptions ?? {});
    if (problem) problems.push(`cron ${job.queue} ${problem}`);
  }
  return problems;
}

/** Job files that call `generateCompletion` and are not named above. */
function unnamedDirectCallers(files: readonly SourceFile[]): string[] {
  return files
    .filter((f) => f.rel.startsWith("lib/jobs/"))
    .filter((f) => /\.generateCompletion(?:Stream)?\(/.test(f.text))
    .map((f) => f.rel)
    .filter((rel) => !(rel in DIRECT_CALL_QUEUES))
    .sort();
}

describe("model-bound queues retry a bounded number of times, backed off", () => {
  const files = sources();
  const queues = modelQueues();

  it("knows the model-bound queues (an empty set is a failure)", () => {
    expect(queues.length).toBeGreaterThanOrEqual(12);
    const declared = new Set(allJobDefinitions().map((j) => j.queue));
    expect(queues.filter((q) => !declared.has(q))).toEqual([]);
  });

  it("names every job file that calls a provider directly", () => {
    expect(unnamedDirectCallers(files)).toEqual([]);
  });

  it("every send to one of them names a bounded, backed-off retry", () => {
    const { problems, sends } = sendFindings(files, queues);
    expect(sends).toBeGreaterThanOrEqual(12);
    expect(problems).toEqual([]);
  });

  it("every cron of one of them carries the same in its schedule options", () => {
    expect(cronFindings(allJobDefinitions(), queues)).toEqual([]);
  });

  it("plants: sends and crons shaped like the tree before #1279 are caught", () => {
    const planted: SourceFile[] = [
      {
        rel: "lib/jobs/planted-queue.ts",
        text: 'export const PLANTED_MEMORY_QUEUE = "planted-memory";\nexport const PLANTED_CARD_QUEUE = "planted-card";',
      },
      {
        rel: "lib/jobs/planted-send.ts",
        text: [
          "await boss.send(PLANTED_MEMORY_QUEUE, payload, {",
          "  singletonKey: `quiet:${id}`,",
          "  startAfter: 600,",
          "});",
          "await boss.send(PLANTED_CARD_QUEUE, payload, { retryLimit: 5, retryDelay: 0 });",
        ].join("\n"),
      },
      {
        rel: "lib/jobs/planted-direct.ts",
        text: "const r = await provider.generateCompletion(params);",
      },
    ];
    expect(
      sendFindings(planted, ["planted-memory", "planted-card"]).problems,
    ).toEqual([
      "lib/jobs/planted-send.ts: send to planted-memory names no retryLimit",
      "lib/jobs/planted-send.ts: send to planted-card retryLimit 5 above 3",
    ]);
    expect(
      cronFindings(
        [{ queue: "coach-nudge", cron: "15 5 * * *" }],
        ["coach-nudge"],
      ),
    ).toEqual(["cron coach-nudge names no retryLimit"]);
    expect(unnamedDirectCallers(planted)).toEqual([
      "lib/jobs/planted-direct.ts",
    ]);
    expect(retryProblem({ retryLimit: 2, retryDelay: 60 })).toBe(
      "retries without retryBackoff",
    );
    expect(
      retryProblem({ retryLimit: 3, retryDelay: 5, retryBackoff: true }),
    ).toBe("retryDelay below 30s");
    expect(retryProblem({ retryLimit: 0 })).toBeNull();
  });
});

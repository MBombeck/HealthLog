/**
 * v1.41 — which background calls may reason, frozen.
 *
 * Reasoning in the background is paid for every night, for every account, by
 * nobody watching. So it is admitted where it changes the result a person
 * reads (the daily briefing and the period narratives) and nowhere else: not
 * on status cards, batch notes, derived scores, workout and reaction lines,
 * nudges, document reads or OCR, which are routine, latency-bound and
 * seed-reproducible.
 *
 * The only way a background call asks is the `reasoningJob` argument of the
 * two chokepoints (`runStatusCompletion`, `runBriefingCompletion`). This test
 * finds every place that sets it and holds the set, file by file and job by
 * job, against the inventory below. A status card that started passing a job
 * goes red here; so does a new caller nobody admitted.
 *
 * Its limit: it reads source text for a `reasoningJob:` property and the job
 * literals beside it. A call that built the argument object elsewhere and
 * spread it in would slip the matcher; the chokepoint signature is the only
 * documented way in, and the wire test (`background-reasoning-wire.test.ts`)
 * proves a call without the argument sends nothing.
 *
 * Mutation check: add `reasoningJob: "daily_briefing"` to
 * `src/lib/insights/status-batch.ts`, or delete it from the narrative
 * generator: either goes red.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BACKGROUND_REASONING_JOBS } from "@/lib/ai/reasoning/levels";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** File → the jobs it may name, each with the reason it may. */
const ADMITTED: Record<string, { jobs: string[]; why: string }> = {
  "lib/insights/comprehensive-generate.ts": {
    jobs: ["daily_briefing"],
    why: "The daily briefing's generation and its phrasing re-roll; the JSON and grounding repairs do not reason.",
  },
  "app/api/insights/generate/route.ts": {
    jobs: ["daily_briefing"],
    why: "A briefing asked for by hand reasons like the scheduled one; its JSON and grounding repairs do not.",
  },
  "lib/insights/narrative/period-narrative-generate.ts": {
    jobs: ["period_narrative_month", "period_narrative_week"],
    why: "The weekly and monthly narratives' first pass; the grounding repair does not reason.",
  },
};

/** The routine generators that must never name a job. */
const NEVER = [
  "lib/insights/status-batch.ts",
  "lib/insights/status-card-generation.ts",
  "lib/insights/metric-status.ts",
  "lib/insights/biomarker-status.ts",
  "lib/insights/derived/derived-assessment-ai.ts",
  "lib/jobs/workout-insight-generate.ts",
];

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** `reasoningJob:` as a value, not the optional declaration `reasoningJob?:`. */
const SETTER = /\breasoningJob\s*:(?!\s*BackgroundReasoningJob)/g;

function scan(): Map<string, { setters: number; jobs: Set<string> }> {
  const found = new Map<string, { setters: number; jobs: Set<string> }>();
  const files = walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"));
  for (const rel of files) {
    const code = stripComments(readFileSync(join(SRC, rel), "utf8"));
    const setters = code.match(SETTER)?.length ?? 0;
    if (setters === 0) continue;
    const jobs = new Set<string>();
    for (const m of code.matchAll(SETTER)) {
      const window = code.slice(m.index, m.index + 160);
      for (const job of BACKGROUND_REASONING_JOBS) {
        if (window.includes(`"${job}"`)) jobs.add(job);
      }
    }
    found.set(rel, { setters, jobs });
  }
  return found;
}

describe("background reasoning inventory", () => {
  const found = scan();

  it("finds the admitted callers (an empty set is a failure, not a pass)", () => {
    expect(found.size).toBeGreaterThanOrEqual(2);
  });

  it("only the admitted files name a job", () => {
    expect([...found.keys()].sort()).toEqual(Object.keys(ADMITTED).sort());
  });

  it.each(Object.entries(ADMITTED))(
    "%s names exactly its admitted jobs",
    (rel, { jobs }) => {
      expect([...(found.get(rel)?.jobs ?? [])].sort()).toEqual(
        [...jobs].sort(),
      );
    },
  );

  it.each(NEVER)("%s never reasons", (rel) => {
    const code = stripComments(readFileSync(join(SRC, rel), "utf8"));
    expect(code).not.toMatch(/\breasoningJob\b/);
    expect(code).not.toMatch(/\breasoning\s*:/);
  });

  it("every admitted job is a known background job", () => {
    for (const { jobs } of Object.values(ADMITTED)) {
      for (const job of jobs) {
        expect(BACKGROUND_REASONING_JOBS as readonly string[]).toContain(job);
      }
    }
  });
});

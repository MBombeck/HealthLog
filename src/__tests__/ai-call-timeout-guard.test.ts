/**
 * Structural guard: every model call runs under the record owner's
 * response-timeout setting.
 *
 * The setting (Settings → AI → response timeout) used to be threaded by hand,
 * and only the briefing, the status notes and the Coach did it. Document
 * reads, document extraction, lab OCR and lab staging called the provider
 * without a `timeoutMs`, so each client fell back to its own 60 s literal and a
 * slow self-hosted model was cut off however high the setting stood.
 *
 * The setting is now bound to the provider instance by the resolver that hands
 * it out, and each client reads its ceiling through `callTimeoutMs`. A call
 * site therefore cannot forget it; what can still go wrong is structural, and
 * each way is pinned here:
 *
 *   1. a wire client reads `params.timeoutMs` (or a literal) itself instead of
 *      `callTimeoutMs(params, this.responseTimeoutSeconds)`;
 *   2. an exported resolver in `provider.ts` returns a provider it did not bind;
 *   3. a client is constructed outside `provider.ts`, where no resolver binds
 *      it (the offline evaluation harness is the one named exception);
 *   4. a surface opts out with `timeoutPolicy: "surface-ceiling"` without
 *      being named below with its reason;
 *   5. an outer bound waits on several model calls in a row but is sized as
 *      one (#1274: the briefing warm gave a five-call generation one call
 *      plus 30 s, so a local model answering in 300 s under a 600 s setting
 *      lost its briefing on the first corrective retry). Every `withTimeout`
 *      around model work is named below with what it must allow, and the
 *      briefing generators' stages are held to the call counts the outer
 *      waits multiply by. A status run waits for its call and the one
 *      reasoning repeat (`STATUS_MODEL_CALLS`).
 *
 * Its limit: it reads source text. A provider object built by hand in
 * production code that dials the network itself would slip all four matchers,
 * and so would a client class imported under an alias.
 * `response-timeout-binding.test.ts` and `provider-response-timeout.test.ts`
 * are what prove the behaviour end to end.
 *
 * Mutation check: put `params.timeoutMs ?? 60_000` back into any client, drop
 * `bindResponseTimeout` from `resolveProviderChain`, construct a
 * `LocalOpenAICompatibleClient` in a route, add
 * `timeoutPolicy: "surface-ceiling"` to the document summary, wrap a model
 * call in a new `withTimeout`, or add a sixth `runBriefingCompletion` stage to
 * the comprehensive generator: each one goes red here.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments, walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");
const AI_DIR = join(SRC, "lib", "ai");

function code(rel: string): string {
  return stripComments(readFileSync(join(SRC, rel), "utf8"));
}

/**
 * The wire clients: every `*-client.ts` that dials through `safeFetch`, or
 * through the call's request budget (`hops.fetch`, `request-hops.ts`).
 */
function wireClients(): string[] {
  return readdirSync(AI_DIR)
    .filter((f) => f.endsWith("-client.ts"))
    .map((f) => `lib/ai/${f}`)
    .filter((rel) => /\b(?:safeFetch|hops\.fetch)\s*\(/.test(code(rel)))
    .sort();
}

const CLIENT_CLASSES = [
  "AnthropicClient",
  "OpenAIClient",
  "LocalOpenAICompatibleClient",
  "CodexClient",
];

// Built fresh per use: a shared `g` regex carries `lastIndex` between
// `.test()` calls and silently skips files.
function construction(): RegExp {
  return new RegExp(`\\bnew\\s+(?:${CLIENT_CLASSES.join("|")})\\s*\\(`, "g");
}

/** Where a client may be constructed, and why no resolver needs to bind it. */
const CONSTRUCTION_SITES: Record<string, string> = {
  "lib/ai/provider.ts":
    "The resolvers. Every exported one binds the record's setting on the way out.",
  "lib/ai/coach/eval/judge.ts":
    "The offline evaluation harness, run by the maintainer against a pinned key; no record and no person's setting.",
};

/**
 * The surfaces whose `timeoutMs` is a hard ceiling the setting does not lift.
 * Each is unattended, latency-bounded by design, and has deterministic copy
 * that stands in when the model does not answer in time.
 */
const SURFACE_CEILING_SITES: Record<string, string> = {
  "lib/jobs/coach-nudge-ai.ts":
    "The 05:15 nudge tick runs accounts one after another under a shared wall-clock budget; one raised setting would starve everyone after it. The template is always ready.",
  "lib/jobs/reaction-line.ts":
    "The claim lease is two minutes, below the largest setting, and the deterministic lead stands in for a line that does not arrive.",
};

describe("wire clients read the bound setting", () => {
  const clients = wireClients();

  it("finds the clients (an empty set is a failure, not a pass)", () => {
    expect(clients.length).toBeGreaterThanOrEqual(4);
  });

  it.each(clients)("%s derives every ceiling through callTimeoutMs", (rel) => {
    const source = code(rel);
    expect(
      source.match(
        /\bcallTimeoutMs\s*\(\s*params\s*,\s*this\s*\.\s*responseTimeoutSeconds\s*\)/g,
      )?.length ?? 0,
    ).toBeGreaterThan(0);
    expect(
      source.match(/\bparams\s*\.\s*timeoutMs\b/g) ?? [],
      "A client read the surface timeout itself and skipped the person's setting. Use callTimeoutMs(params, this.responseTimeoutSeconds).",
    ).toEqual([]);
  });
});

describe("every exported resolver binds", () => {
  const source = code("lib/ai/provider.ts");
  // One chunk per export; the header is everything up to the brace that
  // opens the body, so a default-object parameter (`= {}`) does not end it.
  const resolvers = source
    .split(/\nexport\s+/)
    .map((chunk) => {
      const m = /^async\s+function\s+(\w+)\s*\(/.exec(chunk);
      if (!m) return null;
      const header = chunk.slice(0, chunk.indexOf("{\n"));
      if (
        !/Promise<\s*(?:AIProvider|ProviderChainResolved\[\])\s*>/.test(header)
      ) {
        return null;
      }
      const end = chunk.indexOf("\n}\n");
      return { name: m[1], body: chunk.slice(header.length, end) };
    })
    .filter((r): r is { name: string; body: string } => r !== null);

  it("finds the resolvers (an empty set is a failure, not a pass)", () => {
    expect(resolvers.map((r) => r.name).sort()).toEqual([
      "resolveProvider",
      "resolveProviderChain",
      "resolveProviderForTest",
    ]);
  });

  it.each([
    "resolveProvider",
    "resolveProviderChain",
    "resolveProviderForTest",
  ])("%s calls bindResponseTimeout", (name) => {
    const resolver = resolvers.find((r) => r.name === name);
    expect(resolver?.body ?? "").toMatch(/\bbindResponseTimeout\s*\(/);
  });
});

describe("clients are built only where a resolver binds them", () => {
  const files = walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"));
  const sites = files.filter((rel) => construction().test(code(rel)));

  it("finds constructions at all", () => {
    expect(sites.length).toBeGreaterThan(0);
    expect(
      code("lib/ai/provider.ts").match(construction())?.length ?? 0,
    ).toBeGreaterThan(10);
  });

  it("every construction site is named, with a reason", () => {
    expect(
      sites.filter((rel) => !(rel in CONSTRUCTION_SITES)),
      "A client is constructed outside provider.ts, so no resolver binds the person's response-timeout setting to it. Resolve it through provider.ts instead.",
    ).toEqual([]);
    expect(
      Object.keys(CONSTRUCTION_SITES).filter((r) => !sites.includes(r)),
    ).toEqual([]);
  });
});

describe("surface ceilings are frozen", () => {
  const files = walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"));
  const sites = files.filter((rel) =>
    /\btimeoutPolicy\s*:\s*["']surface-ceiling["']/.test(code(rel)),
  );

  it("names every surface that keeps its own ceiling", () => {
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.sort()).toEqual(Object.keys(SURFACE_CEILING_SITES).sort());
  });
});

/**
 * Every `withTimeout` around model work. It cannot stop the calls it waits
 * for, so it is a backstop against a wedged run and has to sit above the
 * longest run those calls allow: the per-call timeout times the calls made
 * one after another. `bound` is what each call site's budget must read.
 */
const OUTER_BOUND_SITES: Record<
  string,
  { sites: number; bound: RegExp; sizedBy?: RegExp; why: string }
> = {
  "lib/jobs/insight-pregenerate.ts": {
    sites: 2,
    bound: /\bwarmBudgetMs\b/,
    sizedBy: /\bwarmBudgetMs\s*=\s*comprehensiveWarmBudgetMs\s*\(/g,
    why: "The comprehensive warm, nightly and forced: the per-call timeout times COMPREHENSIVE_MODEL_CALLS, plus headroom.",
  },
  "lib/insights/status-provider.ts": {
    sites: 1,
    bound: /\bstatusRunBoundMs\(\s*effectiveTimeoutMs\s*\)/,
    sizedBy: /\breturn\s+effectiveTimeoutMs\s*\*\s*STATUS_MODEL_CALLS\b/g,
    why: "One status run in a background job: the per-call timeout times STATUS_MODEL_CALLS, the call and the one repeat a thinking model gets (#1274). The card keeps its fallback copy meanwhile.",
  },
  "lib/jobs/morning-digest-refresh.ts": {
    sites: 1,
    bound:
      /\bcomprehensiveWarmBudgetMs\(\s*user\.aiResponseTimeoutSeconds\s*\)/,
    why: "The morning refresh's one comprehensive generation: the same per-call timeout times COMPREHENSIVE_MODEL_CALLS the warms use, below the job's expiry (#1274).",
  },
};

describe("outer bounds around model work allow every call they wait on", () => {
  const files = walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .filter((p) => p !== "lib/insights/with-timeout.ts");
  const callsIn = (rel: string): string[] => {
    const source = code(rel);
    return [...source.matchAll(/\bwithTimeout\s*\(/g)].map((m) =>
      source.slice(m.index, m.index + 900),
    );
  };
  const sites = files.filter((rel) => callsIn(rel).length > 0);

  it("names every file that bounds model work from outside", () => {
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.sort()).toEqual(Object.keys(OUTER_BOUND_SITES).sort());
  });

  it.each(Object.entries(OUTER_BOUND_SITES))(
    "%s sizes each bound from the setting",
    (rel, { sites: count, bound, sizedBy }) => {
      const calls = callsIn(rel);
      expect(calls).toHaveLength(count);
      for (const call of calls) expect(call).toMatch(bound);
      if (sizedBy) {
        expect(code(rel).match(sizedBy) ?? []).toHaveLength(count);
      }
    },
  );

  /** The `stage` of every briefing completion a file starts. */
  function stagesIn(rel: string): string[] {
    return [...code(rel).matchAll(/\bstage:\s*"([a-z-]+)",/g)].map((m) => m[1]);
  }

  it("the comprehensive generator makes no more calls in a row than the warm waits for", () => {
    // `reroll` replaces `generate` on an unchanged snapshot; the other four
    // run one after another, and the Local and gateway clients may ask the
    // first again once. A new stage means a longer generation: recount
    // COMPREHENSIVE_MODEL_CALLS before adding it here.
    expect(stagesIn("lib/insights/comprehensive-generate.ts").sort()).toEqual([
      "generate",
      "grounding-retry",
      "json-retry",
      "reroll",
      "screen-retry",
    ]);
    expect(code("lib/ai/ai-budgets.ts")).toMatch(
      /\bCOMPREHENSIVE_MODEL_CALLS\s*=\s*5\b/,
    );
  });

  it("the on-demand regenerate makes no more calls in a row than the browser waits for", () => {
    // The route's own pipeline: the generation and its grounding retry, and
    // the one repeat inside the client (FORCE_ADVISOR_MODEL_CALLS in the
    // advisor hook). An unparseable reply or a screened payload is refused,
    // not retried, and the background generator is never reached from here,
    // which is why this is shorter than COMPREHENSIVE_MODEL_CALLS. A new
    // stage anywhere on the route means recounting the browser's abort.
    const pipeline = [
      "app/api/insights/generate/route.ts",
      ...walkSourceFiles(join(SRC, "lib/insights/briefing-request"), {
        floor: 8,
      })
        .filter((f) => !f.includes("__tests__"))
        .map((f) => `lib/insights/briefing-request/${f}`),
    ];
    expect(pipeline.flatMap(stagesIn).sort()).toEqual([
      "generate",
      "grounding-retry",
    ]);
    for (const rel of pipeline) {
      expect(code(rel), rel).not.toMatch(/\bgenerateComprehensiveInsight\b/);
    }
    expect(code("components/insights/use-insights-advisor.ts")).toMatch(
      /\bFORCE_ADVISOR_MODEL_CALLS\s*=\s*3\b/,
    );
  });
});

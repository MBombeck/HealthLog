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
 *      being named below with its reason.
 *
 * Its limit: it reads source text. A provider object built by hand in
 * production code that dials the network itself would slip all four matchers,
 * and so would a client class imported under an alias.
 * `response-timeout-binding.test.ts` and `provider-response-timeout.test.ts`
 * are what prove the behaviour end to end.
 *
 * Mutation check: put `params.timeoutMs ?? 60_000` back into any client, drop
 * `bindResponseTimeout` from `resolveProviderChain`, construct a
 * `LocalOpenAICompatibleClient` in a route, or add
 * `timeoutPolicy: "surface-ceiling"` to the document summary: each one goes
 * red here.
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

/** The wire clients: every `*-client.ts` that dials through `safeFetch`. */
function wireClients(): string[] {
  return readdirSync(AI_DIR)
    .filter((f) => f.endsWith("-client.ts"))
    .map((f) => `lib/ai/${f}`)
    .filter((rel) => /\bsafeFetch\s*\(/.test(code(rel)))
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

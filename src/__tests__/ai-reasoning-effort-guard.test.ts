/**
 * Structural guard (#1126): `reasoning_effort` reaches a model only through
 * the setting the resolver bound to the provider instance.
 *
 * Default must send nothing, so the key may not appear on any wire except as
 * the bound value or the call's own resolved level, and only the two clients
 * whose endpoint a person chose may carry it. Pinned here:
 *
 *   1. the key appears in exactly the Local client and the OpenAI client,
 *      twice each: once as `reasoning_effort: this.reasoningEffort`, sent
 *      only when the call carries no level of its own (`!params.reasoning`),
 *      and once as the call's level (v1.41 `CompletionParams.reasoning`,
 *      resolved upstream against the person's choice and the operator's
 *      cap), never as a literal;
 *   2. nothing but the binder assigns `.reasoningEffort`;
 *   3. every exported resolver in `provider.ts` calls `bindReasoningEffort`.
 *
 * That clients are constructed only in `provider.ts` (so a resolver always
 * binds them) is frozen by `ai-call-timeout-guard.test.ts`.
 *
 * Its limit: it reads source text. A body built under a computed key, or a
 * resolver that binds through an alias, would slip it.
 * `reasoning-effort.test.ts` and `provider-reasoning-effort.test.ts` prove
 * the behaviour on the wire.
 *
 * Mutation check: hard-code `reasoning_effort: "none"` into either client,
 * drop the `!params.reasoning` condition in front of the bound value,
 * set `client.reasoningEffort = ...` in a route, or drop `bindReasoningEffort`
 * from `resolveProviderForTest`: each one goes red here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function code(rel: string): string {
  return stripComments(readFileSync(join(SRC, rel), "utf8"));
}

const files = walkSourceFiles(SRC, { floor: 3000 })
  .filter((p) => !p.startsWith("generated/"))
  .filter((p) => !p.includes("__tests__"))
  .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"));

describe("reasoning_effort on the wire", () => {
  // As an object key: the published descriptions name the field in prose.
  const KEY = /\breasoning_effort["']?\s*:/g;
  const sites = files.filter((rel) => new RegExp(KEY).test(code(rel)));

  it("appears in the Local and the OpenAI client only", () => {
    expect(sites.sort()).toEqual([
      "lib/ai/local-client.ts",
      "lib/ai/openai-client.ts",
    ]);
  });

  it.each(["lib/ai/local-client.ts", "lib/ai/openai-client.ts"])(
    "%s sends the bound value only without a call level, and never a literal",
    (rel) => {
      const source = code(rel);
      expect(source.match(new RegExp(KEY))?.length).toBe(2);
      expect(source).toMatch(
        /\breasoning_effort\s*:\s*this\s*\.\s*reasoningEffort\b/,
      );
      expect(source).toMatch(
        /!\s*params\s*\.\s*reasoning\s*&&\s*(?:this\s*\.\s*isGateway\s*&&\s*)?this\s*\.\s*reasoningEffort\b/,
      );
      expect(source).not.toMatch(/\breasoning_effort["']?\s*:\s*["'`]/);
    },
  );
});

/** Where `.reasoningEffort` may be assigned, and why. */
const ASSIGNMENT_SITES: Record<string, string> = {
  "lib/ai/reasoning-effort.ts":
    "The binder, the one place a provider instance gets its value.",
  "lib/ai/provider-chain.ts":
    "Writes the stored chain entry, not a provider instance.",
};

describe("only the binder assigns it to a provider", () => {
  it("names every assignment site, with a reason", () => {
    const sites = files.filter((rel) =>
      /\.\s*reasoningEffort\s*=(?!=)/.test(code(rel)),
    );
    expect(sites.sort()).toEqual(Object.keys(ASSIGNMENT_SITES).sort());
  });
});

describe("every exported resolver binds it", () => {
  const source = code("lib/ai/provider.ts");
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

  it.each(resolvers.map((r) => r.name))(
    "%s calls bindReasoningEffort",
    (name) => {
      const resolver = resolvers.find((r) => r.name === name);
      expect(resolver?.body ?? "").toMatch(/\bbindReasoningEffort\s*\(/);
    },
  );
});

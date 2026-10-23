/**
 * Structural guard (#1267): a browser request that waits on a model call
 * takes its abort from the person's response-timeout setting, never from a
 * constant.
 *
 * The force regenerate aborted at a fixed 45 s while the server still had
 * minutes left on the person's 600 s setting, and a save of the about-me
 * self-context (which derives the clarifying questions inline) ran under the
 * 15 s request default. Both now read `clientAbortMs` through the account
 * payload's `ai.provider.responseTimeoutMs`; the inventory of every such
 * request is in the release notes for #1267.
 *
 * Its limit: it reads source text. A new synchronous AI route called from the
 * browser with a fixed `AbortSignal.timeout(...)` is not found by name here;
 * `use-insights-advisor-force.test.ts` proves the behaviour for the
 * regenerate with fake timers.
 *
 * Mutation check: put `FORCE_ADVISOR_TIMEOUT_MS = 45_000` back into the
 * advisor, or drop the `signal` from one about-me save, and this goes red.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments, walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** The text of the call that starts at `open` (the index of its `(`). */
function callText(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

describe("browser aborts for model-backed requests", () => {
  it("the force regenerate derives its abort from the setting", () => {
    const source = stripComments(
      readFileSync(
        join(SRC, "components/insights/use-insights-advisor.ts"),
        "utf8",
      ),
    );
    expect(source).not.toMatch(/FORCE_ADVISOR_TIMEOUT_MS/);
    expect(source).toMatch(
      /options\.force\s*\?\s*forceAdvisorTimeoutMs\(options\.responseTimeoutMs\)/,
    );
    expect(source).toMatch(
      /fetchAdvisor\(\{\s*force:\s*true,\s*responseTimeoutMs\s*\}\)/,
    );
  });

  it("every about-me save carries the setting-derived signal", () => {
    const sites: string[] = [];
    const missing: string[] = [];
    for (const rel of walkSourceFiles(SRC, { floor: 3000 })) {
      if (rel.includes("__tests__/") || rel.startsWith("generated/")) continue;
      if (!rel.startsWith("components/") && !rel.startsWith("app/")) continue;
      const source = stripComments(readFileSync(join(SRC, rel), "utf8"));
      const pattern =
        /apiPut(?:<[^>]*>)?\s*\(\s*["']\/api\/coach\/about-me["']/g;
      for (const match of source.matchAll(pattern)) {
        const open = (match.index ?? 0) + match[0].indexOf("(");
        sites.push(rel);
        if (
          !/signal:\s*AbortSignal\.timeout\(saveTimeoutMs\)/.test(
            callText(source, open),
          )
        ) {
          missing.push(rel);
        }
      }
    }
    // Six saves today; a matcher that finds none must not read as clean.
    expect(sites.length).toBeGreaterThanOrEqual(6);
    expect(missing).toEqual([]);
  });
});

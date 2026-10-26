/**
 * Structural guard (#1279): a provider client that sends a request again on
 * its own sends every request through the call's budget, and hands that
 * budget to every repeat.
 *
 * A client that repeats a request (`this.generateCompletion(` or
 * `this.generateCompletionStream(` inside its own class) decided each repeat
 * from what it had just learned, and two lessons that undid each other made
 * one call send requests until something outside stopped it. The budget in
 * `src/lib/ai/request-hops.ts` refuses the request past two; it can only do
 * that if no request goes around it and no repeat starts a fresh one. So, in
 * every such client:
 *
 *   - no request goes out through `safeFetch(` directly, only `hops.fetch(`;
 *   - every repeat passes `hops` on;
 *   - each public entry takes the budget as its last parameter, defaulting
 *     to a fresh one, so a caller outside starts one per call.
 *
 * `request-hops.test.ts` walks the refusal and answerless combinations
 * against a loopback server and counts the requests.
 *
 * Its limit: it reads source text. A client that repeats through a helper
 * that is not a method named `generateCompletion*`, or sends through another
 * transport, is not found here.
 *
 * Mutation check: drop `hops` from one repeat, or put one `safeFetch(` back
 * into either client, and this goes red.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readSourceText,
  requireFloor,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const AI = join(process.cwd(), "src/lib/ai");

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

const REPEAT = /\bthis\.generateCompletion(?:Stream)?\s*\(/g;

function repeatingClients(): Array<{ rel: string; source: string }> {
  const out: Array<{ rel: string; source: string }> = [];
  for (const rel of walkSourceFiles(AI, { floor: 40 })) {
    if (rel.includes("__tests__/")) continue;
    const source = stripComments(readSourceText(join(AI, rel)));
    if (REPEAT.test(source)) out.push({ rel, source });
    REPEAT.lastIndex = 0;
  }
  return out;
}

describe("a client's own repeats stay inside the call's request budget", () => {
  const clients = repeatingClients();

  it("finds the clients that repeat a request", () => {
    // The Local client and the OpenAI-compatible gateway client today.
    requireFloor("repeating clients", clients, 2);
    expect(clients.map((c) => c.rel).sort()).toEqual([
      "local-client.ts",
      "openai-client.ts",
    ]);
  });

  it("sends every request through the budget", () => {
    for (const { rel, source } of clients) {
      expect({ rel, direct: /\bsafeFetch\s*\(/.test(source) }).toEqual({
        rel,
        direct: false,
      });
      expect({ rel, counted: /\bhops\.fetch\s*\(/.test(source) }).toEqual({
        rel,
        counted: true,
      });
    }
  });

  it("hands the budget to every repeat", () => {
    const repeats: Array<{ rel: string; text: string }> = [];
    for (const { rel, source } of clients) {
      for (const m of source.matchAll(REPEAT)) {
        const open = (m.index ?? 0) + m[0].length - 1;
        repeats.push({ rel, text: callText(source, open) });
      }
    }
    requireFloor("repeats", repeats, 6);
    expect(
      repeats.filter(({ text }) => !/,\s*hops\s*,?\s*\)$/.test(text)),
    ).toEqual([]);
  });

  it("starts one budget per call at each public entry", () => {
    const entries: Array<{ rel: string; text: string }> = [];
    for (const { rel, source } of clients) {
      for (const m of source.matchAll(
        /\basync\s+generateCompletion(?:Stream)?\s*\(/g,
      )) {
        const open = (m.index ?? 0) + m[0].length - 1;
        entries.push({ rel, text: callText(source, open) });
      }
    }
    requireFloor("public entries", entries, 3);
    expect(
      entries.filter(
        ({ text }) =>
          !/hops:\s*RequestHops\s*=\s*new RequestHops\(\)\s*,?\s*\)$/.test(
            text,
          ),
      ),
    ).toEqual([]);
  });
});

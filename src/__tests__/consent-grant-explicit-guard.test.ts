/**
 * An AI consent receipt is minted only by the person's own tap.
 *
 * From v1.16.13 until v1.43.2 the AI settings page posted to
 * `/api/consent/ai/web` in a `useEffect` on every visit and the server minted
 * an `ai_full` receipt for it, so an account that had agreed to nothing sent
 * its health data to the operator's provider from background jobs. The fix has
 * two ends, and this file holds the client one; the server end (both grant
 * routes refuse a body without `confirm: true`) is pinned by the route tests
 * and re-checked structurally at the bottom.
 *
 *   1. Exactly two client modules may name a grant route: the `ai_full` hook
 *      and the document-reading hook. Each sends `confirm: true`. Any other
 *      file that names `/api/consent/ai` or `/api/consent/ai/web` fails here,
 *      which is how a second mount-time grant would get in.
 *   2. Every `.mutate(` / `.mutateAsync(` of those hooks sits in a click
 *      handler: on a line that carries `onClick`, or in a named function
 *      that some `onClick={name}` in the same file hands the click to. None
 *      sits inside a `useEffect` / `useLayoutEffect`.
 *
 * Its limits: it reads source text, so a grant reached through a variable
 * holding the path, or a hook result passed to another component and called
 * there, would slip past rule 2. The counts below fail on an empty match set,
 * so a matcher that stops matching is red rather than quietly green.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";
import { stripComments } from "./helpers/source-files";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

/** The two modules allowed to send a grant, and what they must send. */
const GRANT_WRITERS = [
  "src/hooks/use-grant-ai-consent.ts",
  "src/hooks/use-grant-document-reading-consent.ts",
];

const GRANT_HOOKS = ["useGrantAiConsent", "useGrantDocumentReadingConsent"];

/** A grant route as a string literal: the bare route or `/web`, nothing longer. */
const GRANT_PATH = /["'`]\/api\/consent\/ai(?:\/web)?["'`]/;

function clientSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "__tests__" ||
        entry.name === "generated" ||
        full === join(SRC, "app", "api") ||
        full === join(SRC, "lib", "openapi")
      ) {
        continue;
      }
      out.push(...clientSources(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function rel(file: string): string {
  return relative(ROOT, file).split(sep).join("/");
}

/** The source spans of every `useEffect(` / `useLayoutEffect(` call. */
function effectSpans(source: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = /\buse(?:Layout)?Effect\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          spans.push([open, i]);
          break;
        }
      }
    }
  }
  return spans;
}

const FILES = clientSources(SRC).map((file) => ({
  path: rel(file),
  source: stripComments(readFileSync(file, "utf8")),
}));

describe("AI consent is granted only by the person's own tap", () => {
  it("names a grant route only in the two grant hooks, each sending confirm: true", () => {
    const naming = FILES.filter((f) => GRANT_PATH.test(f.source)).map(
      (f) => f.path,
    );
    expect(naming.sort()).toEqual([...GRANT_WRITERS].sort());
    for (const writer of GRANT_WRITERS) {
      const source = FILES.find((f) => f.path === writer)!.source;
      expect(source, writer).toMatch(/\bconfirm:\s*true\b/);
    }
  });

  it("calls a grant only from a click handler, never from an effect", () => {
    let callers = 0;
    let sites = 0;
    for (const file of FILES) {
      for (const hook of GRANT_HOOKS) {
        const assign = new RegExp(
          `\\bconst\\s+(\\w+)\\s*=\\s*${hook}\\s*\\(`,
          "g",
        );
        let assigned: RegExpExecArray | null;
        while ((assigned = assign.exec(file.source)) !== null) {
          callers += 1;
          const name = assigned[1];
          const call = new RegExp(`\\b${name}\\.mutate(?:Async)?\\s*\\(`, "g");
          const effects = effectSpans(file.source);
          const lines = file.source.split("\n");
          let site: RegExpExecArray | null;
          while ((site = call.exec(file.source)) !== null) {
            sites += 1;
            const at = site.index;
            const where = `${file.path}: ${name}.mutate`;
            expect(
              effects.some(([from, to]) => at > from && at < to),
              `${where} inside an effect`,
            ).toBe(false);

            const lineNo = file.source.slice(0, at).split("\n").length - 1;
            if (/\bonClick\b/.test(lines[lineNo] ?? "")) continue;
            // Otherwise the nearest enclosing named function must be the one
            // a click hands to.
            const before = file.source.slice(0, at);
            const fns = [
              ...before.matchAll(
                /\bfunction\s+(\w+)\s*\(|\bconst\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,
              ),
            ];
            const enclosing = fns.at(-1);
            const fnName = enclosing?.[1] ?? enclosing?.[2];
            expect(fnName, `${where} outside any named handler`).toBeDefined();
            expect(
              new RegExp(`onClick=\\{\\s*${fnName}\\s*\\}`).test(file.source),
              `${where} in ${fnName}, which no onClick hands the click to`,
            ).toBe(true);
          }
        }
      }
    }
    // Non-zero floors: a matcher that stops matching is red, not green.
    expect(callers).toBeGreaterThanOrEqual(3);
    expect(sites).toBeGreaterThanOrEqual(3);
  });

  it("keeps both grant routes refusing a request without the confirmation", () => {
    for (const route of [
      "src/app/api/consent/ai/route.ts",
      "src/app/api/consent/ai/web/route.ts",
    ]) {
      const source = readFileSync(join(ROOT, route), "utf8");
      expect(source, route).toMatch(/CONSENT_CONFIRM_REQUIRED_ERROR_CODE/);
    }
  });
});

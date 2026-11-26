/**
 * No server or client code under `src/` relies on a `console` method the
 * production build strips.
 *
 * `compiler.removeConsole` in `next.config.ts` keeps `console.error` and
 * `console.warn` and removes every other `console` call from the production
 * bundle, argument expressions included. A line written with `console.log`,
 * `console.info` or `console.debug` therefore shows in `next dev` and in the
 * unit suite, and is gone from every container. The setup token of a fresh
 * install was printed that way: the line the getting-started guide sends an
 * operator to grep for never reached a production log, and the first account
 * could not be created. Two boot notices shared the fault.
 *
 * Operator-facing lines go through `operatorLine` (`src/lib/logging/
 * operator-line.ts`), a direct stdout write the build leaves alone; problems
 * keep `console.warn` / `console.error`. This guard fails on any stripped
 * call, and on a change to the build's keep-list that would make its
 * assumption wrong.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readSourceText,
  requireFloor,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

/** A `console.<method>(` call, whitespace-tolerant. */
const CONSOLE_CALL = /\bconsole\s*\.\s*([A-Za-z]+)\s*\(/g;

/** What `removeConsole` keeps, as `next.config.ts` states it. */
const KEPT = new Set(["error", "warn"]);

function productionFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__") && !p.includes("__mocks__"))
    .filter((p) => !/\.(?:test|spec)\.tsx?$/.test(p));
}

function consoleCalls(): { file: string; method: string; line: number }[] {
  const out: { file: string; method: string; line: number }[] = [];
  for (const file of productionFiles()) {
    const text = stripComments(readSourceText(join(SRC, file)));
    for (const match of text.matchAll(CONSOLE_CALL)) {
      out.push({
        file,
        method: match[1],
        line: text.slice(0, match.index).split("\n").length,
      });
    }
  }
  return out;
}

describe("operator lines survive the production build", () => {
  it("the build keeps exactly console.error and console.warn", () => {
    const config = stripComments(readSourceText(join(ROOT, "next.config.ts")));
    const removeConsole = /removeConsole\s*:([\s\S]*?)\n\s*\}/.exec(config);
    expect(removeConsole, "removeConsole in next.config.ts").not.toBeNull();
    const exclude = /exclude\s*:\s*\[([^\]]*)\]/.exec(removeConsole![1]);
    expect(exclude, "removeConsole.exclude").not.toBeNull();
    const kept = [...exclude![1].matchAll(/["']([a-z]+)["']/g)].map(
      (m) => m[1],
    );
    expect(new Set(kept)).toEqual(KEPT);
  });

  it("no source file calls a console method the build strips", () => {
    const calls = consoleCalls();
    // The matcher is proven on the calls that are allowed: a sweep that finds
    // no console call at all is a broken sweep, not a clean tree.
    requireFloor(
      "kept console calls under src",
      calls.filter((c) => KEPT.has(c.method)),
      50,
    );
    const stripped = calls
      .filter((c) => !KEPT.has(c.method))
      .map((c) => `${c.file}:${c.line} console.${c.method}`);
    expect(stripped).toEqual([]);
  });

  it("the setup token and the boot notices are written with operatorLine", () => {
    for (const file of [
      "lib/auth/setup-token.ts",
      "lib/boot/key-check.ts",
      "instrumentation.ts",
    ]) {
      const text = stripComments(readSourceText(join(SRC, file)));
      expect(text, file).toMatch(/\boperatorLine\s*\(/);
    }
  });
});

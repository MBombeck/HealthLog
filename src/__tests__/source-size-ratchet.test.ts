/**
 * File and function size may only shrink.
 *
 * Two caps over the production source (see `helpers/source-metrics.ts` for
 * what counts): a file over 800 lines, and a function over 200 lines. Most of
 * the large files are one large function, so both are measured, through the
 * TypeScript compiler.
 *
 * Every file and function over its cap today is in a baseline under
 * `baselines/` with its current length. From here:
 *
 *   - a new file or function over the cap fails;
 *   - a baselined one that grows past its recorded length fails. If the
 *     growth is deliberate, raising the number is a hand edit of the JSON in
 *     a reviewed change, with the reason in the PR;
 *   - a baselined one that shrank by more than the slack (or fell under the
 *     cap) fails until the lower number is written back with
 *     `RATCHET_WRITE=1 pnpm vitest run src/__tests__/source-size-ratchet.test.ts`.
 *     The slack (25 lines for a file, 10 for a function) keeps a small edit
 *     from forcing a baseline commit; a real split always crosses it.
 *
 * Catalog and data files are exempt from both caps: their length is the
 * length of the thing they list, and splitting them changes navigation, not
 * cohesion. Each is named below with its reason, and a named file that no
 * longer exists fails, so the list cannot outlive its entries.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { requireFloor } from "./helpers/source-files";
import {
  SRC,
  lineCount,
  measureFunctions,
  parse,
  productionSources,
  readSrc,
} from "./helpers/source-metrics";
import { runRatchet, writeBackHint } from "./helpers/ratchet";

const FILE_CAP = 800;
const FUNCTION_CAP = 200;
const GUARD = "src/__tests__/source-size-ratchet.test.ts";

/**
 * Exempt from both caps. A key ending in `/` covers the folder. Paths are
 * relative to `src/`.
 */
const CATALOGS: Readonly<Record<string, string>> = {
  "lib/openapi/routes/":
    "the OpenAPI contract: one schema and one path entry per route, grows with the API surface",
  "lib/signals/registry.ts": "the SIGNALS record, one entry per signal",
  "lib/ai/coach/eval/golden-cases.ts": "Coach evaluation fixtures",
  "lib/ai/coach/system-prompt.ts": "prompt text",
  "lib/measurements/apple-health-mapping.ts":
    "the HealthKit identifier mapping table",
  "lib/labs/biomarker-catalog.ts": "the biomarker catalogue",
  "app/privacy/page.tsx":
    "legal copy rendered as React text, one long static component",
};

function isCatalog(rel: string): boolean {
  return Object.keys(CATALOGS).some((key) =>
    key.endsWith("/") ? rel.startsWith(key) : rel === key,
  );
}

function measure() {
  const files = productionSources();
  const fileLines: Record<string, number> = {};
  const functionLines: Record<string, number> = {};
  let functionsSeen = 0;
  for (const rel of files) {
    if (isCatalog(rel)) continue;
    const text = readSrc(rel);
    const lines = lineCount(text);
    if (lines > FILE_CAP) fileLines[rel] = lines;
    for (const fn of measureFunctions(parse(rel, text))) {
      functionsSeen += 1;
      if (fn.lines > FUNCTION_CAP)
        functionLines[`${rel} :: ${fn.name}`] = fn.lines;
    }
  }
  return { files: files.length, functionsSeen, fileLines, functionLines };
}

describe("source size ratchet", () => {
  const m = measure();

  it("reads the whole tree", () => {
    expect(m.files).toBeGreaterThan(3000);
    expect(m.functionsSeen).toBeGreaterThan(20_000);
    // The floor follows the ratchet down: 115 files sat over the cap before
    // the large-component splits, 96 after. It guards the matcher, so it sits
    // under the real count, not at it.
    requireFloor("files over the cap", Object.keys(m.fileLines), 80);
    requireFloor("functions over the cap", Object.keys(m.functionLines), 300);
  });

  it(`no file over ${FILE_CAP} lines grows, and none is added`, () => {
    const r = runRatchet("source-file-lines.json", m.fileLines, {
      slack: 25,
      comment: `Production files over ${FILE_CAP} lines and their length. Maintained by ${GUARD}.`,
    });
    expect(
      r.grew,
      `Files over ${FILE_CAP} lines that are new or longer than their baseline. Split the file, or raise its number in src/__tests__/baselines/source-file-lines.json in a reviewed change with the reason.`,
    ).toEqual([]);
    expect(r.stale, writeBackHint(GUARD)).toEqual([]);
  });

  it(`no function over ${FUNCTION_CAP} lines grows, and none is added`, () => {
    const r = runRatchet("source-function-lines.json", m.functionLines, {
      slack: 10,
      comment: `Production functions over ${FUNCTION_CAP} lines, keyed "file :: name", and their length. Maintained by ${GUARD}.`,
    });
    expect(
      r.grew,
      `Functions over ${FUNCTION_CAP} lines that are new or longer than their baseline. Extract a part, or raise its number in src/__tests__/baselines/source-function-lines.json in a reviewed change with the reason.`,
    ).toEqual([]);
    expect(r.stale, writeBackHint(GUARD)).toEqual([]);
  });

  it("names no catalog that is gone", () => {
    const missing = Object.keys(CATALOGS).filter(
      (key) => !existsSync(join(SRC, key)),
    );
    expect(missing).toEqual([]);
  });
});

describe("the function measure", () => {
  const fns = (text: string) => measureFunctions(parse("probe.ts", text));

  it("names declarations, assignments, methods and call arguments", () => {
    const names = fns(
      [
        "export function a() {}",
        "const b = () => {};",
        "const o = { c() {}, d: function () {} };",
        "class K { constructor() {} e() {} }",
        "wrap(async () => {});",
        "function f() { return () => 1; }",
      ].join("\n"),
    ).map((f) => f.name);
    expect(names).toEqual([
      "a",
      "b",
      "c",
      "d",
      "constructor",
      "e",
      "wrap(arg)",
      "f",
      "f > (anonymous)",
    ]);
  });

  it("counts lines from the first to the last line of the node", () => {
    const [fn] = fns("function a() {\n  x();\n  y();\n}\n");
    expect(fn.lines).toBe(4);
    expect(fn.line).toBe(1);
  });

  it("keeps two same-named functions apart", () => {
    const names = fns("call(() => 1);\ncall(() => 2);").map((f) => f.name);
    expect(names).toEqual(["call(arg)", "call(arg) #2"]);
  });
});

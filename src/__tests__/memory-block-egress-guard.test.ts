/**
 * v1.41 — what the person told the Coach leaves the machine only when the
 * turn may send to its providers.
 *
 * The memory block (`WHAT YOU KNOW ABOUT THIS PERSON`) carries facts, plans
 * and reminders the person wrote; the briefing's plan lines carry plan
 * targets. Both are built, not built-then-dropped: the egress or capability
 * check runs first and nothing is read on a refusal. Behaviour is pinned in
 * `memory/__tests__/context-block.test.ts` and `plan-progress.test.ts`; this
 * guard pins the structure those tests rest on:
 *
 * 1. Inside each builder, the check comes before the first database read.
 * 2. The builders are called only from the files that run after the turn's
 *    own egress check (the Coach turn) or behind the briefing capability (the
 *    briefing generation), and a Coach-turn caller hands over the chain so
 *    the wire check runs for exactly those providers.
 * 3. No `annotate()` in the memory modules names a text-bearing value.
 *
 * Every check is also run against a source broken on purpose.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");
const MEMORY = "lib/ai/coach/memory";

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"));
}

/** The body of `export async function <name>(`, up to the next top-level `}`. */
function functionBody(source: string, name: string): string {
  const start = source.search(
    new RegExp(`export\\s+async\\s+function\\s+${name}\\s*\\(`),
  );
  if (start === -1) return "";
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end === -1 ? undefined : end);
}

/** Whether `check` appears before the first database read in `body`. */
function checksBeforeRead(body: string, check: RegExp): boolean {
  const checkAt = body.search(check);
  const readAt = body.search(
    /\bprisma\.|\bload(?:Facts|Plans|Reminders)\(|takePendingProposal\(/,
  );
  return checkAt !== -1 && readAt !== -1 && checkAt < readAt;
}

describe("memory block egress guard", () => {
  const block = functionBody(
    read(`${MEMORY}/context-block.ts`),
    "buildMemoryContextBlock",
  );
  const lines = functionBody(
    read(`${MEMORY}/plan-progress.ts`),
    "buildPlanProgressLines",
  );

  it("the memory block checks egress before it reads anything", () => {
    expect(block.length).toBeGreaterThan(200);
    expect(checksBeforeRead(block, /egressAllowed\(/)).toBe(true);
    const helper = read(`${MEMORY}/context-block.ts`);
    expect(helper).toMatch(/aiEgressRefusal\(\s*"coach"/);
    expect(helper).toMatch(/aiCapabilityForRecord\(args\.userId, "coach"\)/);
    // Broken on purpose: the check moved below the reads.
    const broken = block.replace(/if \(!\(await egressAllowed\(args\)\)\)/, "");
    expect(checksBeforeRead(broken, /egressAllowed\(/)).toBe(false);
  });

  it("the briefing's plan lines check the briefing capability before any read", () => {
    expect(lines.length).toBeGreaterThan(200);
    expect(
      checksBeforeRead(lines, /aiCapabilityForRecord\(userId, "briefing"\)/),
    ).toBe(true);
    const broken = lines.replace(
      /aiCapabilityForRecord\(userId, "briefing"\)/,
      "",
    );
    expect(
      checksBeforeRead(broken, /aiCapabilityForRecord\(userId, "briefing"\)/),
    ).toBe(false);
  });

  /**
   * Files that may build the memory block: the Coach turn, after its own
   * capability and consent checks (`turn/pipeline.ts` rechecks before it
   * runs the model). The contract re-exports it; nothing else calls it.
   */
  const BLOCK_CALLERS = new Set([
    "lib/ai/coach/turn/model.ts",
    "lib/ai/coach/turn/context.ts",
  ]);
  /** Files that may build the briefing's plan lines. */
  const LINE_CALLERS = new Set([
    "lib/insights/comprehensive-generate.ts",
    "lib/insights/briefing-provider.ts",
  ]);

  function callers(name: string): string[] {
    const call = new RegExp(`\\b${name}\\(`);
    return sourceFiles()
      .filter((rel) => !rel.startsWith(`${MEMORY}/`))
      .filter((rel) => call.test(read(rel)));
  }

  it("only the Coach turn builds the memory block, and it names its providers", () => {
    const found = callers("buildMemoryContextBlock");
    for (const rel of found) {
      expect(BLOCK_CALLERS.has(rel), rel).toBe(true);
      expect(read(rel), `${rel} hands over the chain`).toMatch(
        /buildMemoryContextBlock\(\{[\s\S]{0,400}providerTypes/,
      );
    }
    // The matcher is live: it finds the definition it guards.
    const definitions = sourceFiles().filter((rel) =>
      /export async function buildMemoryContextBlock\(/.test(read(rel)),
    );
    expect(definitions).toEqual([`${MEMORY}/context-block.ts`]);
  });

  it("only the briefing builds the plan lines", () => {
    for (const rel of callers("buildPlanProgressLines")) {
      expect(LINE_CALLERS.has(rel), rel).toBe(true);
    }
  });

  it("no memory annotation names a text-bearing value", () => {
    const TEXT =
      /\b(?:fact|text|ifCue|thenAction|target|recalled|note\.fact|userMessage|content)\s*[,:}]/;
    const offending: string[] = [];
    const files = walkSourceFiles(join(SRC, MEMORY), { floor: 5 }).filter(
      (p) => !p.includes("__tests__"),
    );
    for (const rel of files) {
      const source = read(`${MEMORY}/${rel}`);
      for (const match of source.matchAll(/annotate\(\{[\s\S]*?\}\);/g)) {
        const meta = match[0].split("meta:")[1] ?? "";
        if (TEXT.test(meta)) offending.push(`${rel}: ${match[0]}`);
      }
    }
    expect(offending).toEqual([]);
    // Broken on purpose: a meta that carries the fact.
    const planted = `annotate({ action: { name: "x" }, meta: { fact: call.fact } });`;
    expect(TEXT.test(planted.split("meta:")[1])).toBe(true);
  });
});

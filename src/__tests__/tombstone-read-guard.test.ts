/**
 * Structural guard: a read that feeds analysis or a model prompt never sees a
 * deleted row.
 *
 * Several record types delete softly: the row stays with `deletedAt` set so
 * sync can propagate the delete and undo can bring it back. Four per-metric
 * status snapshots read mood entries with `where: { userId }` alone, so an
 * entry the person had deleted kept shaping the text written about them, and
 * the blood-pressure snapshot did the same with measurements.
 *
 * The models are derived from the schema (every model with a `deletedAt`
 * column), not listed by hand, so a model that gains soft delete is covered
 * the day it does. The scope is every directory whose output is analysis,
 * a score, an insight, or model input. A read passes when its argument names
 * `deletedAt`, or when it filters through a local object that does. The
 * entries below read tombstones on purpose and say why. Comments are
 * stripped first; the planted cases prove the matcher fires.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments, walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

const SCOPES = [
  "lib/insights/",
  "lib/analytics/",
  "lib/ai/",
  "lib/rollups/",
  "lib/doctor-report/",
  "lib/day/",
  "lib/timeline/",
  "lib/targets/",
  "lib/gamification/",
  "lib/mood/",
  "app/api/insights/",
  "app/api/analytics/",
  "app/api/dashboard/",
  // Request-handler logic moved out of its route into a service keeps the
  // route's scope.
  "lib/dashboard/widgets/",
];

/** `model@file` → why this read includes deleted rows. */
const ALLOWED: Record<string, string> = {
  "measurement@lib/rollups/measurement-rollups.ts":
    "Freshness probe on updatedAt: a delete bumps it and must invalidate the rollup.",
  "moodEntry@lib/rollups/mood-rollups.ts":
    "Freshness probe on updatedAt: a delete bumps it and must invalidate the rollup.",
  "coachFact@lib/ai/coach/memory/trail-read.ts":
    "Withholds medication texts from the recall trail; a deleted fact still withholds, which errs toward saying less.",
  "coachFact@lib/ai/coach/memory/remember.ts":
    "Answer-once check on the message that proposed the fact, inside its lock.",
  "moodEntry@lib/mood/bulk-ingest.ts":
    "Write path, not analysis: resolves the row that won a raced external-id upsert, which owns the key whether or not it is deleted.",
};

function tombstonedModels(): string[] {
  const schema = readFileSync(
    join(process.cwd(), "prisma/schema.prisma"),
    "utf8",
  );
  const models = new Set<string>();
  let current: string | null = null;
  for (const line of schema.split("\n")) {
    const head = /^model\s+(\w+)\s*\{/.exec(line);
    if (head) current = head[1];
    else if (/^\}/.test(line)) current = null;
    else if (current && /^\s+deletedAt\s+DateTime\?/.test(line)) {
      models.add(current[0].toLowerCase() + current.slice(1));
    }
  }
  return [...models].sort();
}

/** The local object a read filters through carries `deletedAt`. */
function filtersThroughLiveObject(
  code: string,
  arg: string,
  at: number,
): boolean {
  const names = [...arg.matchAll(/(?:where:\s*|\.\.\.)(\w+)/g)].map(
    (m) => m[1],
  );
  if (/(?:^|[{,])\s*where\s*[,}]/.test(arg)) names.push("where");
  return names.some((name) => {
    // The nearest declaration above the read is the one it uses.
    const decl = new RegExp(
      `(?:const|let)\\s+${name}\\b[^=]*=\\s*\\{([\\s\\S]{0,600}?)\\};`,
      "g",
    );
    const before = [...code.slice(0, at).matchAll(decl)].at(-1);
    return before !== undefined && /\bdeletedAt\b/.test(before[1]);
  });
}

export function unfilteredReads(
  code: string,
  models: string[],
): { model: string; arg: string }[] {
  const re = new RegExp(
    `\\.(${models.join("|")})\\s*\\.\\s*(findMany|findFirst|count|groupBy|aggregate)\\s*\\(`,
    "g",
  );
  const out: { model: string; arg: string }[] = [];
  for (const m of code.matchAll(re)) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (depth > 0 && i < code.length) {
      if (code[i] === "(") depth += 1;
      else if (code[i] === ")") depth -= 1;
      i += 1;
    }
    const arg = code.slice(m.index + m[0].length, i - 1);
    if (/\bdeletedAt\b/.test(arg)) continue;
    if (filtersThroughLiveObject(code, arg, m.index)) continue;
    out.push({ model: m[1], arg: arg.replace(/\s+/g, " ").slice(0, 120) });
  }
  return out;
}

describe("analysis reads skip deleted rows", () => {
  const models = tombstonedModels();

  it("derives the soft-deleting models from the schema", () => {
    expect(models.length).toBeGreaterThanOrEqual(20);
    expect(models).toContain("moodEntry");
    expect(models).toContain("measurement");
  });

  it("the matcher fires on an unfiltered read and passes a filtered one", () => {
    const planted = `const rows = await prisma.moodEntry
      .findMany({ where: { userId }, take: 90 });`;
    expect(unfilteredReads(planted, models)).toHaveLength(1);
    expect(
      unfilteredReads(
        "await prisma.moodEntry.findMany({ where: { userId, deletedAt: null } });",
        models,
      ),
    ).toEqual([]);
    const viaLocal = `const where = { userId, deletedAt: null };
      await prisma.measurement.count({ where });`;
    expect(unfilteredReads(viaLocal, models)).toEqual([]);
    const viaLocalWithout = `const where = { userId };
      await prisma.measurement.count({ where });`;
    expect(unfilteredReads(viaLocalWithout, models)).toHaveLength(1);
  });

  it("no read in scope includes deleted rows outside the list", () => {
    const files = walkSourceFiles(SRC, { floor: 3000 }).filter(
      (file) =>
        SCOPES.some((scope) => file.startsWith(scope)) &&
        !file.includes("__tests__/") &&
        !/\.test\.tsx?$/.test(file),
    );
    expect(files.length).toBeGreaterThan(400);

    let reads = 0;
    const readRe = new RegExp(`\\.(${models.join("|")})\\s*\\.\\s*find`, "g");
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(join(SRC, file), "utf8"));
      reads += [...code.matchAll(readRe)].length;
      for (const hit of unfilteredReads(code, models)) {
        const key = `${hit.model}@${file}`;
        if (!(key in ALLOWED)) offenders.push(`${key}: ${hit.arg}`);
      }
    }
    // The scope reads these models in well over a hundred places; a sweep
    // that finds a handful read the wrong tree.
    expect(reads).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});

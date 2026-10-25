/**
 * Structural guard: background work skips accounts pending deletion.
 *
 * An account pending deletion is locked for its grace window and frozen as
 * it was: no reminder, sync, copy, rollup, score, digest or Coach pass may act
 * for it (`src/lib/account-deletion/active-account.ts`). Background work
 * reaches accounts by enumerating them, so every query in background work
 * that reads across accounts has to filter them out — and a new query is the
 * one most likely to forget.
 *
 * The rule, for every `findMany(` / `groupBy(` / `count(` / `aggregate(`,
 * every `updateMany(` / `deleteMany(` (a sweep that writes into every
 * account's rows acts for each of them as much as a read does), and every raw
 * SQL query or statement that touches accounts' rows in the background work
 * below:
 *
 *   - it names the shared predicate (`ACTIVE_ACCOUNT`,
 *     `OWNED_BY_ACTIVE_ACCOUNT` or `activeAccountSql`), or its result goes
 *     straight into `dropPendingDeletion` (a scan of `measurements`, too
 *     large to join `users` into per row), or
 *   - it is scoped to named accounts (a `userId` it was handed, an `id` list
 *     it already filtered), read from its filter only: `orderBy`, `by`,
 *     `distinct`, `select` and `include` name columns without scoping
 *     anything, or
 *   - a comment directly above it says why it needn't:
 *     `// account-deletion: <reason>` (a ledger read, the purge's own query,
 *     …), or the module says so for all of its queries:
 *     `// account-deletion(file): <reason>` (an encryption backfill, a
 *     retention sweep over rows rather than accounts).
 *
 * Two chokepoints back it up behaviourally (the notification dispatcher and
 * the AI capability loader refuse a pending account; see their tests), so a
 * scope the matcher misreads cannot send a reminder or start model work.
 *
 * It is a tripwire, not a proof: the scoping regex is shape-based. Its own
 * matchers are held to non-zero counts, and the last test plants a query
 * that forgets the predicate and requires the rule to catch it.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/**
 * Where background work lives: every job module, plus the shared candidate
 * builders outside `src/lib/jobs` that jobs call to enumerate accounts.
 */
const EXTRA_FILES = [
  "lib/measurements/consolidation-base.ts",
  "lib/integrations/watchdog.ts",
  // Read by the hourly readiness evaluation, which judges every account's
  // copies.
  "lib/recovery/readiness.ts",
  // Boot discovery and cron sweeps that live beside their domain rather
  // than under `lib/jobs`.
  "lib/rollups/measurement-rollups.ts",
  "lib/rollups/mood-rollups.ts",
  "lib/personal-records/cumulative-pr-rederivation.ts",
  "lib/medications/intake-slot-dedup.ts",
  "lib/medications/inventory/service.ts",
  "lib/workouts/climb-backfill.ts",
];

/** Job folders that live beside their domain. */
const EXTRA_DIRS = [{ dir: "lib/fitbit/jobs", floor: 5 }];

function backgroundFiles(): string[] {
  const walk = (dir: string, floor: number) =>
    walkSourceFiles(join(SRC, dir), { floor })
      .filter((rel) => !rel.includes("__tests__"))
      .filter((rel) => !rel.endsWith(".test.ts"))
      .map((rel) => `${dir}/${rel}`);
  return [
    ...walk("lib/jobs", 150),
    ...EXTRA_DIRS.flatMap(({ dir, floor }) => walk(dir, floor)),
    ...EXTRA_FILES,
  ].sort();
}

const PREDICATE =
  /\b(?:ACTIVE_ACCOUNT|OWNED_BY_ACTIVE_ACCOUNT|activeAccountSql|activeAccount|ownedByActiveAccount|excludePendingOwners)\b/;

/** A query scoped to accounts it was handed, not one that finds them. */
const SCOPED = [
  // `{ userId }`, `userId: x`, `userId: { in: ids }` — but not a select
  // (`userId: true`) or a negation that reads every other account.
  /\b(?:userId|recordUserId|subjectId|grantorId|profileId)\s*(?:[,}\n]|:(?!\s*(?:true|false)\b|\s*\{\s*(?:not|notIn)\b))/,
  /\bid\s*:\s*(?:userId|input\.userId|\{\s*in\b)/,
  // `id: user.id`, `id: account.id`: the one account a loop is on.
  /\bid\s*:\s*[\w$]+\.(?:id|userId)\b/,
  /"?user_id"?\s*=\s*(?:\$\{|ANY\s*\(\s*\$\{)/,
  /\bu\."id"\s*=\s*\$\{/,
  /"id"\s*=\s*(?:\$\{|ANY\s*\(\s*\$\{)/,
];

const MARKER = /\/\/\s*account-deletion:\s*\S/;

/**
 * The same, for a module whose every query is maintenance of rows rather than
 * work for an account (an encryption backfill, a retention sweep, a ledger):
 * `// account-deletion(file): <reason>` anywhere in it.
 */
const FILE_MARKER = /\/\/\s*account-deletion\(file\):\s*\S/;

export interface Query {
  file: string;
  line: number;
  text: string;
  /** Whether the query's result goes straight into `dropPendingDeletion`. */
  dropped: boolean;
}

/** `dropPendingDeletion(db, await <the query>` right before the call. */
const DROPPED = /dropPendingDeletion\s*\(\s*[\w$]+\s*,\s*await\s+[\w$.]+$/;

/** The text between the opener at `open` and its matching closer. */
function balanced(code: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  let i = open;
  for (; i < code.length; i++) {
    const ch = code[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "`") {
      // A template: read to its closing backtick, `${…}` included.
      const end = templateEnd(code, i);
      i = end;
    } else if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) break;
    }
  }
  return code.slice(open, i + 1);
}

/** The index of the backtick closing the template opened at `start`. */
function templateEnd(code: string, start: number): number {
  let i = start + 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") return i;
    if (ch === "$" && code[i + 1] === "{") {
      const inner = balanced(code, i + 1);
      i += 1 + inner.length;
      continue;
    }
    i++;
  }
  return i;
}

/** Every query or sweep call and account SQL in `source`. */
export function queriesIn(file: string, source: string): Query[] {
  const code = stripComments(source);
  const lineOf = (index: number) => code.slice(0, index).split("\n").length;
  const out: Query[] = [];
  const dropped = (index: number) =>
    DROPPED.test(code.slice(Math.max(0, index - 200), index));
  for (const m of code.matchAll(
    /\.(?:findMany|groupBy|updateMany|deleteMany|count|aggregate)\s*\(/g,
  )) {
    const open = m.index + m[0].length - 1;
    out.push({
      file,
      line: lineOf(m.index),
      text: balanced(code, open),
      dropped: dropped(m.index),
    });
  }
  for (const m of code.matchAll(
    /\.\$(?:queryRaw|queryRawUnsafe|executeRaw|executeRawUnsafe)\b/g,
  )) {
    const rest = code.slice(m.index + m[0].length);
    const tick = rest.search(/[`(]/);
    if (tick < 0) continue;
    const at = m.index + m[0].length + tick;
    const text =
      code[at] === "`"
        ? code.slice(at, templateEnd(code, at) + 1)
        : balanced(code, at);
    // SQL that reads no account (the queue's own tables, catalogue sizes)
    // enumerates nobody.
    if (!/\buser_id\b|"users"|\busers\b/.test(text)) continue;
    out.push({ file, line: lineOf(m.index), text, dropped: dropped(m.index) });
  }
  return out;
}

/** Whether a comment within the three lines above `line` gives a reason. */
function markedAt(source: string, line: number): boolean {
  const lines = source.split("\n");
  const from = Math.max(0, line - 4);
  return lines.slice(from, line).some((text) => MARKER.test(text));
}

/**
 * The parts of a query's arguments that say which rows it reads, without the
 * ones that only shape the answer. `orderBy: [{ day: "asc" }, { userId: "asc" }]`
 * names `userId` and scopes nothing; read as a scope, it let three nightly
 * score jobs group every account's rows, frozen ones included, past this
 * guard. The same goes for `by`, `distinct`, `select` and `include`.
 */
const SHAPE_KEY = /\b(?:orderBy|by|distinct|select|include)\s*:\s*(?=[[{])/g;

export function filterText(text: string): string {
  let out = "";
  let from = 0;
  for (const m of text.matchAll(SHAPE_KEY)) {
    if (m.index < from) continue;
    const open = m.index + m[0].length;
    out += text.slice(from, m.index);
    from = open + balanced(text, open).length;
  }
  return out + text.slice(from);
}

export function violations(file: string, source: string): Query[] {
  if (FILE_MARKER.test(source)) return [];
  return queriesIn(file, source).filter(
    (q) =>
      !q.dropped &&
      !PREDICATE.test(q.text) &&
      !SCOPED.some((re) => re.test(filterText(q.text))) &&
      !markedAt(source, q.line),
  );
}

describe("background work skips accounts pending deletion", () => {
  const files = backgroundFiles();

  it("reads the background work it is about", () => {
    expect(files.length).toBeGreaterThan(150);
    const all = files.flatMap((file) =>
      queriesIn(file, readSourceText(join(SRC, file))),
    );
    // A matcher that finds nothing proves nothing.
    expect(all.length).toBeGreaterThan(100);
    expect(all.filter((q) => PREDICATE.test(q.text)).length).toBeGreaterThan(
      15,
    );
  });

  it("every cross-account query filters, is scoped, or says why not", () => {
    const found = files.flatMap((file) =>
      violations(file, readSourceText(join(SRC, file))),
    );
    expect(
      found.map((q) => `${q.file}:${q.line}`),
      "Filter with ACTIVE_ACCOUNT / OWNED_BY_ACTIVE_ACCOUNT / activeAccountSql " +
        "(src/lib/account-deletion/active-account.ts), or put " +
        "`// account-deletion: <reason>` directly above the query.",
    ).toEqual([]);
  });

  it("catches a query that forgets the predicate", () => {
    const planted = [
      "export async function sweep() {",
      "  const users = await prisma.user.findMany({",
      "    where: { moodReminderEnabled: true },",
      "    select: { id: true },",
      "  });",
      "  const rows = await prisma.$queryRaw`",
      '    SELECT "id" FROM "users" WHERE "telegram_enabled"`;',
      "}",
    ].join("\n");
    expect(violations("planted.ts", planted)).toHaveLength(2);

    const fixed = planted
      .replace(
        "where: { moodReminderEnabled: true }",
        "where: { moodReminderEnabled: true, ...ACTIVE_ACCOUNT }",
      )
      .replace(
        'WHERE "telegram_enabled"`',
        'WHERE "telegram_enabled" AND ${activeAccountSql(\'"id"\')}`',
      );
    expect(violations("planted.ts", fixed)).toHaveLength(0);

    const select = planted.replace(
      "select: { id: true }",
      "select: { id: true, userId: true }",
    );
    // Selecting `userId` is not a scope.
    expect(violations("planted.ts", select)).toHaveLength(2);
  });

  // `orderBy: { userId: "asc" }` names the column and scopes nothing; read
  // as a scope it hid three nightly score jobs that grouped every account's
  // rows, frozen ones included.
  it("does not read an order, a grouping or a selection as a scope", () => {
    for (const shape of [
      'orderBy: { userId: "asc" }',
      'orderBy: [{ _max: { measuredAt: "desc" } }, { userId: "asc" }]',
      'by: ["userId"]',
      'distinct: ["userId"]',
      "select: { userId: true, user: { select: { id: true } } }",
    ]) {
      const planted = `export async function s() { await prisma.measurement.groupBy({ where: { type: "WEIGHT" }, ${shape} }); }`;
      expect(violations("planted.ts", planted), shape).toHaveLength(1);
    }
    const scoped =
      'export async function s(userId: string) { await prisma.measurement.findMany({ where: { userId }, orderBy: { userId: "asc" } }); }';
    expect(violations("planted.ts", scoped)).toHaveLength(0);
  });

  it("catches a sweep that writes into every account's rows", () => {
    const planted = [
      "export async function sweep() {",
      "  await prisma.coachPlan.updateMany({",
      '    where: { status: "proposed" },',
      '    data: { status: "abandoned" },',
      "  });",
      "  await prisma.$executeRaw`UPDATE measurements SET x = 1 WHERE user_id IS NOT NULL`;",
      "}",
    ].join("\n");
    expect(violations("planted.ts", planted)).toHaveLength(2);
  });
});

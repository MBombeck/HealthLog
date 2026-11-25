/**
 * A file that reads a JSON document on the account row and writes the same
 * document back does so under the row lock (`src/lib/user-row-lock.ts`).
 *
 * Several settings live as JSON documents on `users`, and a write that changes
 * one field of such a document reads what is stored, merges the field in and
 * writes the whole document back. Two such writes that overlap both read the
 * same document, and the later one drops the earlier one's field. The fix is
 * `withUserRowLock` / `lockUserRow` (`SELECT ... FOR UPDATE`), or the
 * revision-guarded write (`guardedUserDocumentUpdate`). The routes were moved
 * onto it one by one, and a route that was not moved stayed invisible, because
 * nothing named the class. This guard names it: every file under `src/app` and
 * `src/lib` that reads one of the `User` model's JSON columns (`column: true`
 * in a select), writes the account row, and writes that column, must take the
 * lock, or be listed below with the reason it does not need it.
 *
 * The column list is read from `prisma/schema.prisma`, so a new JSON column is
 * covered the day it lands. The matcher is grep-shaped: it sees a file, not a
 * code path, so a file that both reads a document for one purpose and writes
 * it for another is listed too, and the exemption must say why the write does
 * not merge. Both the column count and the match count are asserted non-zero,
 * so a matcher that finds nothing fails instead of passing.
 *
 * Its limit: a read and a write that live in different files (a route that
 * reads the blob and hands a finished map to a helper that writes it) are not
 * seen here. `tests/integration/user-preference-merge-concurrency.test.ts`
 * drives the known cases with overlapping writes.
 */
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";
import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const REPO = join(__dirname, "..", "..");
const ROOTS: [string, number][] = [
  [join(REPO, "src", "app"), 500],
  [join(REPO, "src", "lib"), 1000],
];

/** The `Json` columns of the `User` model, from the schema. */
function userJsonColumns(): string[] {
  const schema = readSourceText(join(REPO, "prisma", "schema.prisma"));
  const block = schema.match(/^model User \{([\s\S]*?)^\}/m)?.[1] ?? "";
  return [...block.matchAll(/^\s+(\w+)\s+Json\??\s/gm)].map((m) => m[1]);
}

/** Non-test source under `root`, outside `__tests__` and `generated`. */
function sourceFiles([root, floor]: [string, number]): string[] {
  return walkSourceFiles(root, { floor })
    .filter(
      (rel) =>
        !/(^|\/)(__tests__|generated)\//.test(rel) &&
        !/\.test\.tsx?$/.test(rel),
    )
    .map((rel) => join(root, rel));
}

/**
 * Files that read and write a document on the account row without the lock,
 * and why that is not a merge. Paths relative to the repository root.
 */
const EXEMPT: Record<string, string> = {
  "src/app/api/auth/me/report-selection/route.ts":
    "replaces the whole document; the read is the audit row's previous value",
  "src/app/api/auth/me/source-priority/route.ts":
    "replaces the whole document; the read is the audit row's previous value",
  "src/app/api/settings/report-schedule/route.ts":
    "replaces cadence and window; the carried run stamps are the job's, which writes them by compare-and-set on the stored document",
  "src/app/api/insights/provider-chains/route.ts":
    "replaces the whole named-chain document; the read is the GET and the response",
  "src/lib/jobs/report-schedule.ts":
    "writes by compare-and-set on the document it read (updateMany where the column equals it)",
  "src/lib/jobs/garmin-backfill.ts":
    "backfill progress is written by the one backfill job of the account",
  "src/lib/jobs/oura-backfill.ts":
    "backfill progress is written by the one backfill job of the account",
  "src/lib/garmin/unavailable.ts":
    "marks the backfill progress of the one backfill job of the account",
  "src/lib/ai/provider.ts":
    "reads the chain to resolve providers and returns it in a plain object; its writes are the Codex token columns",
  "src/lib/oura/credentials.ts":
    "replaces the whole denied-scope set; the read only skips an unchanged write",
};

const LOCKED =
  /\bwithUserRowLock\s*\(|\blockUserRow\s*\(|FOR\s+UPDATE|\bguardedUserDocumentUpdate\s*\(/;
const WRITES_USER_ROW = /\.user\s*\.\s*(update|updateMany|upsert)\s*\(/;

function escape(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const columns = userJsonColumns();

const matches = ROOTS.flatMap(sourceFiles)
  .map((path) => {
    const text = stripComments(readSourceText(path), path);
    if (!WRITES_USER_ROW.test(text)) return null;
    const merged = columns.filter((column) => {
      const name = escape(column);
      const read = new RegExp(`\\b${name}\\s*:\\s*true\\b`).test(text);
      const written =
        new RegExp(`\\b${name}\\s*:\\s*(?!true\\b)[^\\s,}]`).test(text) ||
        new RegExp(`\\.${name}\\s*=(?!=)`).test(text);
      return read && written;
    });
    if (merged.length === 0) return null;
    return {
      file: relative(REPO, path),
      columns: merged,
      locked: LOCKED.test(text),
    };
  })
  .filter((m): m is NonNullable<typeof m> => m !== null);

describe("read-merge-writes of an account document hold the row lock", () => {
  it("reads the JSON columns from the schema", () => {
    expect(columns.length).toBeGreaterThan(10);
    expect(columns).toContain("aiProviderChain");
    expect(columns).toContain("thresholdsJson");
  });

  it("finds the read-merge-write files", () => {
    // Locked since the merge routes moved onto the helper; their presence
    // proves the matcher still sees the shape.
    const files = matches.map((m) => m.file);
    expect(files).toContain("src/app/api/user/thresholds/route.ts");
    expect(files).toContain("src/app/api/user/ai-provider/route.ts");
    expect(files).toContain("src/app/api/insights/provider-chain/route.ts");
    expect(matches.length).toBeGreaterThan(15);
  });

  it.each(matches.map((m) => [m.file, m]))(
    "%s takes the row lock or is exempt",
    (_file, m) => {
      if (m.file in EXEMPT) return;
      expect(
        m.locked,
        `${m.file} reads and writes ${m.columns.join(", ")} without the row lock`,
      ).toBe(true);
    },
  );

  it("lists no exemption that no longer matches", () => {
    const files = new Set(matches.map((m) => m.file));
    const stale = Object.keys(EXEMPT).filter((file) => !files.has(file));
    expect(stale).toEqual([]);
  });

  it("lists no exemption for a file that takes the lock", () => {
    const locked = matches
      .filter((m) => m.locked && m.file in EXEMPT)
      .map((m) => m.file);
    expect(locked).toEqual([]);
  });
});

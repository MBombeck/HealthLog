/**
 * A file that reads a JSON document on the account row or the instance
 * settings row and writes the same document back does so under that row's
 * lock (`src/lib/user-row-lock.ts`, `src/lib/app-settings-row-lock.ts`).
 *
 * Several settings live as JSON documents on `users` and on the one
 * `app_settings` row, and a write that changes one field of such a document
 * reads what is stored, merges the field in and writes the whole document
 * back. Two such writes that overlap both read the same document, and the
 * later one drops the earlier one's field. The fix is the row lock
 * (`SELECT ... FOR UPDATE`), or for the account row the revision-guarded
 * write (`guardedUserDocumentUpdate`). The routes were moved onto it one by
 * one, and a route that was not moved stayed invisible, because nothing named
 * the class. This guard names it: every file under `src/app` and `src/lib`
 * that reads one of a covered model's JSON columns (`column: true` in a
 * select), writes that model's row, and writes that column, must take the
 * lock, or be listed below with the reason it does not need it.
 *
 * The column lists are read from `prisma/schema.prisma`, so a new JSON column
 * is covered the day it lands. The matcher is grep-shaped: it sees a file, not
 * a code path, so a file that both reads a document for one purpose and
 * writes it for another is listed too, and the exemption must say why the
 * write does not merge. The column counts and the match counts are asserted
 * non-zero, so a matcher that finds nothing fails instead of passing.
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

/** The `Json` columns of a model, from the schema. */
function jsonColumns(model: string): string[] {
  const schema = readSourceText(join(REPO, "prisma", "schema.prisma"));
  const block =
    schema.match(new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, "m"))?.[1] ??
    "";
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

/** A row whose JSON documents are covered: its client, its lock, exemptions. */
interface CoveredRow {
  model: string;
  writes: RegExp;
  locked: RegExp;
  /** Files that read and write a document without the lock, and why that is
   *  not a merge. Paths relative to the repository root. */
  exempt: Record<string, string>;
}

const ROWS: CoveredRow[] = [
  {
    model: "User",
    writes: /\.user\s*\.\s*(update|updateMany|upsert)\s*\(/,
    locked:
      /\bwithUserRowLock\s*\(|\blockUserRow\s*\(|FOR\s+UPDATE|\bguardedUserDocumentUpdate\s*\(/,
    exempt: {
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
    },
  },
  {
    model: "AppSettings",
    writes: /\.appSettings\s*\.\s*(update|updateMany|upsert)\s*\(/,
    locked:
      /\bwithAppSettingsRowLock\s*\(|\blockAppSettingsRow\s*\(|FOR\s+UPDATE/,
    exempt: {},
  },
];

function escape(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const files = ROOTS.flatMap(sourceFiles).map((path) => ({
  file: relative(REPO, path),
  text: stripComments(readSourceText(path), path),
}));

const covered = ROWS.map((row) => {
  const columns = jsonColumns(row.model);
  const matches = files
    .map(({ file, text }) => {
      if (!row.writes.test(text)) return null;
      const merged = columns.filter((column) => {
        const name = escape(column);
        const read = new RegExp(`\\b${name}\\s*:\\s*true\\b`).test(text);
        const written =
          new RegExp(`\\b${name}\\s*:\\s*(?!true\\b)[^\\s,}]`).test(text) ||
          new RegExp(`\\.${name}\\s*=(?!=)`).test(text);
        return read && written;
      });
      if (merged.length === 0) return null;
      return { file, columns: merged, locked: row.locked.test(text) };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);
  return { ...row, columns, matches };
});

const user = covered.find((row) => row.model === "User")!;
const appSettings = covered.find((row) => row.model === "AppSettings")!;

describe("read-merge-writes of a settings document hold the row lock", () => {
  it("reads the JSON columns from the schema", () => {
    expect(user.columns.length).toBeGreaterThan(10);
    expect(user.columns).toContain("aiProviderChain");
    expect(user.columns).toContain("thresholdsJson");
    expect(appSettings.columns).toContain("moduleAvailabilityJson");
  });

  it("finds the read-merge-write files", () => {
    // Locked since the merge routes moved onto the helpers; their presence
    // proves the matcher still sees the shape.
    const userFiles = user.matches.map((m) => m.file);
    expect(userFiles).toContain("src/app/api/user/thresholds/route.ts");
    expect(userFiles).toContain("src/app/api/user/ai-provider/route.ts");
    expect(userFiles).toContain("src/app/api/insights/provider-chain/route.ts");
    expect(user.matches.length).toBeGreaterThan(15);
    const settingsFiles = appSettings.matches.map((m) => m.file);
    expect(settingsFiles).toContain(
      "src/app/api/admin/settings/module-availability/route.ts",
    );
    expect(settingsFiles).toContain("src/lib/admin/server-setup-store.ts");
    expect(settingsFiles).toContain("src/lib/jobs/pulse-day-mean.ts");
  });

  it.each(
    covered.flatMap((row) =>
      row.matches.map((m) => [`${row.model}: ${m.file}`, row, m] as const),
    ),
  )("%s takes the row lock or is exempt", (_label, row, m) => {
    if (m.file in row.exempt) return;
    expect(
      m.locked,
      `${m.file} reads and writes ${row.model}.${m.columns.join(", ")} without the row lock`,
    ).toBe(true);
  });

  it("lists no exemption that no longer matches", () => {
    const stale = covered.flatMap((row) => {
      const found = new Set(row.matches.map((m) => m.file));
      return Object.keys(row.exempt).filter((file) => !found.has(file));
    });
    expect(stale).toEqual([]);
  });

  it("lists no exemption for a file that takes the lock", () => {
    const locked = covered.flatMap((row) =>
      row.matches.filter((m) => m.locked && m.file in row.exempt),
    );
    expect(locked.map((m) => m.file)).toEqual([]);
  });
});

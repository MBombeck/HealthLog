/**
 * No account is looked up by a pattern.
 *
 * Prisma's `mode: "insensitive"` compiles to `ILIKE` on Postgres, and the
 * value goes in as the pattern unescaped: `_` matches any one character and
 * `%` any run. On an identity column that turned a lookup into a search —
 * `%` signed in as whichever account came first, `a_ice` found `alice`, and
 * an invitation to `j_doe` could reach `jxdoe` and hand it the record. Account
 * lookups by e-mail or username go through `@/lib/auth/identity-lookup`
 * (`lower(col) = lower($1)`, the expression migration 0517's keys index).
 *
 * Two rules, over every non-test source file under `src/`:
 *   1. no `mode: "insensitive"` filter sits on an identity column, except the
 *      listed searches (which escape their input, rule 2);
 *   2. every `mode: "insensitive"` filter passes its value through
 *      `likeLiteral()` (`@/lib/db-like`), so a search for `a_b` finds `a_b`.
 *
 * Every occurrence of the operator must be attributed to the column it
 * filters, or the guard fails: a filter written in a shape the matcher cannot
 * read (built in a variable, spread in) is a failure to look at, not a pass.
 * The matcher itself is exercised on fixtures below, so a matcher that finds
 * nothing fails too.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readSourceText,
  requireFloor,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** Columns that name an account. A filter on them is an account lookup. */
const IDENTITY_COLUMNS = new Set([
  "email",
  "username",
  "oidcIssuer",
  "oidcSub",
]);

/**
 * Searches, not lookups, that may filter an identity column by substring.
 * Each entry names the file and the column; each must still be found, so a
 * stale entry fails.
 */
const IDENTITY_SEARCHES: ReadonlyArray<{
  file: string;
  column: string;
  count: number;
  reason: string;
}> = [
  {
    file: "app/api/admin/audit-log/route.ts",
    column: "username",
    count: 2,
    reason:
      "The admin audit-log filter searches acting accounts by part of a name (cookie-only admin surface, capped). It resolves nobody's identity.",
  },
];

const MODE = /\bmode\s*:\s*["'`]insensitive["'`]/g;
/** `column: { …, mode: "insensitive" … }`, across lines, no nested braces. */
const KEYED =
  /([A-Za-z_$][\w$]*)\s*:\s*\{([^{}]*?\bmode\s*:\s*["'`]insensitive["'`][^{}]*)\}/g;

interface Filter {
  file: string;
  line: number;
  column: string;
  body: string;
}

function scan(
  file: string,
  source: string,
): { filters: Filter[]; operators: number } {
  const code = stripComments(source);
  const operators = [...code.matchAll(MODE)].length;
  const filters = [...code.matchAll(KEYED)].map((m) => ({
    file,
    line: code.slice(0, m.index).split("\n").length,
    column: m[1],
    body: m[2],
  }));
  return { filters, operators };
}

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !/\.test\.tsx?$/.test(p));
}

function scanTree(): { filters: Filter[]; unattributed: string[] } {
  const filters: Filter[] = [];
  const unattributed: string[] = [];
  for (const file of sourceFiles()) {
    const result = scan(file, readSourceText(join(SRC, file)));
    filters.push(...result.filters);
    if (result.filters.length !== result.operators) {
      unattributed.push(
        `${file}: ${result.operators} operator(s), ${result.filters.length} attributed`,
      );
    }
  }
  return { filters, unattributed };
}

describe("the matcher", () => {
  it("attributes a filter written across lines, in either key order", () => {
    const { filters, operators } = scan(
      "fixture.ts",
      `prisma.user.findFirst({ where: { OR: [
        { email: {
            equals: identifier,
            mode: "insensitive",
        } },
        { username: { mode: 'insensitive', equals: identifier } },
        { name: { contains: likeLiteral(q), mode: "insensitive" as const } },
      ] } });`,
    );
    expect(operators).toBe(3);
    expect(filters.map((f) => f.column)).toEqual(["email", "username", "name"]);
  });

  it("counts a filter it cannot attribute instead of skipping it", () => {
    const { filters, operators } = scan(
      "fixture.ts",
      `const f = { equals: x, mode: "insensitive" };
       const g = { ...f, mode: "insensitive" };`,
    );
    // `const f = {` is no `key: {`; the two must not agree.
    expect(operators).toBe(2);
    expect(filters.length).toBeLessThan(operators);
  });

  it("ignores the operator inside a comment", () => {
    const { operators } = scan(
      "fixture.ts",
      `// email: { equals: x, mode: "insensitive" }\nconst a = 1;`,
    );
    expect(operators).toBe(0);
  });
});

describe("case-insensitive filters under src/", () => {
  const { filters, unattributed } = scanTree();

  it("reads every one of them", () => {
    requireFloor("mode: insensitive filters", filters, 20);
    expect(unattributed).toEqual([]);
  });

  it("puts none on an identity column outside the listed searches", () => {
    const offenders = filters
      .filter((f) => IDENTITY_COLUMNS.has(f.column))
      .filter(
        (f) =>
          !IDENTITY_SEARCHES.some(
            (s) => s.file === f.file && s.column === f.column,
          ),
      )
      .map((f) => `${f.file}:${f.line} ${f.column}`);
    expect(
      offenders,
      'Look accounts up through @/lib/auth/identity-lookup, never with mode: "insensitive" (ILIKE: _ and % are wildcards).',
    ).toEqual([]);
  });

  it("finds each listed search where it is listed", () => {
    for (const search of IDENTITY_SEARCHES) {
      const found = filters.filter(
        (f) => f.file === search.file && f.column === search.column,
      );
      expect(found.length, `${search.file} ${search.column}`).toBe(
        search.count,
      );
    }
  });

  it("escapes the value of every one with likeLiteral()", () => {
    const unescaped = filters
      .filter((f) => !/\blikeLiteral\s*\(/.test(f.body))
      .map((f) => `${f.file}:${f.line} ${f.column}`);
    expect(
      unescaped,
      "Wrap the value in likeLiteral() from @/lib/db-like, or _ and % in it act as wildcards.",
    ).toEqual([]);
  });
});

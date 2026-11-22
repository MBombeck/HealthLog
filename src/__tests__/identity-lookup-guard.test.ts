/**
 * No account is looked up by a pattern, and no search treats its input as one.
 *
 * Prisma's `mode: "insensitive"` compiles to `ILIKE` on Postgres, and the
 * value goes in as the pattern unescaped: `_` matches any one character and
 * `%` any run. On an identity column that turned a lookup into a search —
 * `%` signed in as whichever account came first, `a_ice` found `alice`, and
 * an invitation to `j_doe` could reach `jxdoe` and hand it the record. Account
 * lookups by e-mail or username go through `@/lib/auth/identity-lookup`
 * (`lower(col) = lower($1)`, the expression migration 0517's keys index).
 *
 * Four rules, over every non-test source file under `src/`:
 *   1. `mode: "insensitive"` is written only in `lib/db-like.ts`, inside
 *      `textContains` / `textEquals`, which escape the value. Everything else
 *      filters through those two, so no filter can forget the escape;
 *   2. neither filter sits on an identity column, except the listed searches;
 *   3. every call of either is attributed to the column it filters. A call
 *      the matcher cannot attribute (the filter kept in a variable, spread in)
 *      fails, rather than passing unseen;
 *   4. no Prisma `where` compares `email` or `username` exactly. Since 0517
 *      the unique keys are on `lower(column)`, so an exact `findUnique` /
 *      `findFirst` misses an account held in another case: a first SSO login
 *      derived a name the key then refused (`oidc_failed` on every retry),
 *      and an address change onto one held in another case answered 500
 *      instead of 409. Those lookups belong in `identity-lookup.ts`.
 *
 * The matchers are exercised on fixtures below and the sweep has a floor, so
 * a matcher that finds nothing fails too.
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
const HELPERS = "lib/db-like.ts";

/** Columns that name an account. A filter on them is an account lookup. */
const IDENTITY_COLUMNS = new Set([
  "email",
  "username",
  "oidcIssuer",
  "oidcSub",
]);

/**
 * Searches, not lookups, that may filter an identity column by substring.
 * Each entry names the file, the column and how often; a stale entry fails.
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
      "The admin audit-log filter finds acting accounts by part of a name (cookie-only admin surface, capped, escaped). It resolves nobody's identity.",
  },
];

const MODE = /\bmode\s*:\s*["'`]insensitive["'`]/g;
/**
 * A `where` object, on one line or several, that names `email` or `username`
 * as a top-level key (`{ email }`, `{ email: x }`, `{ id: { not: y },
 * username: z }`). A nested object is stepped over whole, so
 * `where: { user: { email } }` is not read as a lookup on this model.
 */
const EXACT_IDENTITY_WHERE =
  /\bwhere\s*:\s*\{(?:[^{}]|\{[^{}]*\})*?\b(email|username)\b\s*(?::\s*([^,}\s]+))?/g;
const IDENTITY_HELPER = "lib/auth/identity-lookup.ts";
const CALL = /(?<![\w$.])text(?:Contains|Equals)\s*\(/g;
const KEYED_CALL = /([A-Za-z_$][\w$]*)\s*:\s*(text(?:Contains|Equals))\s*\(/g;

interface Filter {
  file: string;
  line: number;
  column: string;
}

function scan(file: string, source: string) {
  const code = stripComments(source);
  const lineOf = (index: number) => code.slice(0, index).split("\n").length;
  return {
    exactLookups: [...code.matchAll(EXACT_IDENTITY_WHERE)].map((m) => ({
      line: lineOf(m.index),
      column: m[1],
      pattern: /^text(?:Contains|Equals)\(/.test(m[2] ?? ""),
    })),
    modes: [...code.matchAll(MODE)].map((m) => lineOf(m.index)),
    calls: [...code.matchAll(CALL)].length,
    filters: [...code.matchAll(KEYED_CALL)].map((m): Filter => ({
      file,
      line: lineOf(m.index),
      column: m[1],
    })),
  };
}

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !/\.test\.tsx?$/.test(p));
}

function scanTree() {
  const filters: Filter[] = [];
  const stray: string[] = [];
  const unattributed: string[] = [];
  const exact: string[] = [];
  let patternLookups = 0;
  let helperModes = 0;
  for (const file of sourceFiles()) {
    const result = scan(file, readSourceText(join(SRC, file)));
    for (const lookup of result.exactLookups) {
      if (lookup.pattern) patternLookups += 1;
      else if (file !== IDENTITY_HELPER) {
        exact.push(`${file}:${lookup.line} ${lookup.column}`);
      }
    }
    if (file === HELPERS) {
      helperModes = result.modes.length;
      continue;
    }
    for (const line of result.modes) stray.push(`${file}:${line}`);
    filters.push(...result.filters);
    if (result.filters.length !== result.calls) {
      unattributed.push(
        `${file}: ${result.calls} call(s), ${result.filters.length} attributed`,
      );
    }
  }
  return { filters, stray, unattributed, helperModes, exact, patternLookups };
}

describe("the matchers", () => {
  it("find the operator across lines, and not inside a comment", () => {
    const { modes } = scan(
      "fixture.ts",
      `// email: { equals: x, mode: "insensitive" }
       prisma.user.findFirst({ where: { email: {
         equals: identifier,
         mode:
           'insensitive',
       } } });`,
    );
    expect(modes).toEqual([4]);
  });

  it("attribute a filter to its column, and count one they cannot", () => {
    const { calls, filters } = scan(
      "fixture.ts",
      `const where = { OR: [
         { username: textEquals(name) },
         { title:
             textContains(q) },
       ] };
       const loose = textContains(q);`,
    );
    expect(filters.map((f) => f.column)).toEqual(["username", "title"]);
    expect(calls).toBe(3);
  });

  it("find an exact identity lookup in every shape it is written", () => {
    const { exactLookups } = scan(
      "fixture.ts",
      `prisma.user.findUnique({ where: { username: candidate } });
       tx.user.findFirst({
         where: {
           id: { not: userId },
           email,
         },
       });
       prisma.user.findUnique({ where: { email: normalizedEmail }, select: { id: true } });
       prisma.user.findMany({ where: { username: textContains(q) } });
       prisma.user.findUnique({ where: { id }, select: { email: true } });`,
    );
    expect(exactLookups.map((l) => [l.line, l.column, l.pattern])).toEqual([
      [1, "username", false],
      [3, "email", false],
      [8, "email", false],
      [9, "username", true],
    ]);
  });
});

describe("case-insensitive filters under src/", () => {
  const { filters, stray, unattributed, helperModes, exact, patternLookups } =
    scanTree();

  it("compare no identity column exactly outside the lookup helper", () => {
    // The listed searches are pattern filters the same matcher sees, so a
    // matcher that stopped matching would fail here rather than pass empty.
    expect(patternLookups).toBeGreaterThanOrEqual(1);
    expect(
      exact,
      "Look accounts up through @/lib/auth/identity-lookup: the unique keys are on lower(column) since 0517, and an exact where misses an account held in another case.",
    ).toEqual([]);
  });

  it("write the operator only in the escaping helpers", () => {
    expect(helperModes).toBe(2);
    expect(
      stray,
      'Filter through textContains() / textEquals() from @/lib/db-like; a bare mode: "insensitive" passes _ and % through as wildcards.',
    ).toEqual([]);
  });

  it("are every one attributed to a column", () => {
    requireFloor("textContains / textEquals filters", filters, 20);
    expect(unattributed).toEqual([]);
  });

  it("sit on no identity column outside the listed searches", () => {
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
      "Look accounts up through @/lib/auth/identity-lookup, never with a pattern filter.",
    ).toEqual([]);
  });

  it("find each listed search where it is listed", () => {
    for (const search of IDENTITY_SEARCHES) {
      const found = filters.filter(
        (f) => f.file === search.file && f.column === search.column,
      );
      expect(found.length, `${search.file} ${search.column}`).toBe(
        search.count,
      );
    }
  });
});

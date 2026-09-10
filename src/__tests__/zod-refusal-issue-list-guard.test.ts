/**
 * Every 422 raised by a Zod `safeParse` names the fields it refused.
 *
 * `returnAllZodIssues` / `apiValidationError` emit `details.issues` — one entry
 * per rejected field — so a client with three bad fields fixes all three in one
 * round-trip instead of three. Most routes use them. Fifty-nine refusal sites
 * did not: they returned the correct 422 with a single opaque sentence, and a
 * client could not map the failure onto a field. Twelve of those put a dotted
 * machine token in `error` instead of a sentence, so `error` was sometimes text
 * to show a person and sometimes a token that must not be shown, with nothing
 * in the payload to tell them apart.
 *
 * The matcher is per-site, not per-file, because per-file is what let this
 * grow: a route that used the helper once and a bare `apiError(..., 422)`
 * somewhere else in the same file looked compliant to a `grep -l` sweep. So
 * every `if (!<result>.success)` block whose identifier came from a `safeParse`
 * in that file is read on its own, and only the blocks that answer 422 are
 * judged — a 400, a 401 or a 403 raised off a parse result is a different
 * refusal and is left alone.
 *
 * Its limits, stated so nobody reads more into a green run than is there:
 * a refusal built somewhere other than the `if (!x.success)` block that decided
 * it — a helper called with the error, a status assembled from a variable — is
 * invisible here, and so is a route that hands the `ZodError` to shared code
 * outside `src/app/api`. It catches the shape this defect actually took, and
 * the count assertion below is what keeps it from passing on a matcher that
 * silently stopped matching anything.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const API_ROOT = join(process.cwd(), "src", "app", "api");

/**
 * Routes that answer a shape refusal without the issue list, each with the
 * reason it must differ. Empty today: every 422 raised off a `safeParse` under
 * `src/app/api` carries `details.issues`. An entry here is a decision, not a
 * backlog item — write why the list cannot ship, not when it will.
 */
const ALLOWLIST: Record<string, string> = {};

/** Every `route.ts` under `src/app/api`, tests excluded. */
function routeFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      found.push(...routeFiles(full));
      continue;
    }
    if (entry.name === "route.ts") found.push(full);
  }
  return found;
}

/**
 * The `{ … }` (or single statement) that follows an `if (…)`, brace-balanced.
 *
 * A refusal is often one statement with no braces — `if (!parsed.success)
 * return apiError("Invalid data", 422);` — so both forms are read.
 */
function refusalBlock(src: string, afterCondition: number): string {
  let i = afterCondition;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] === "{") {
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") {
        depth--;
        if (depth === 0) return src.slice(i, j + 1);
      }
    }
    return src.slice(i);
  }
  const end = src.indexOf(";", i);
  return src.slice(i, end === -1 ? src.length : end + 1);
}

interface RefusalSite {
  route: string;
  line: number;
  carriesIssues: boolean;
}

/** Every 422 refusal decided by a `safeParse` result, across the route tree. */
function scanRefusalSites(): RefusalSite[] {
  const sites: RefusalSite[] = [];
  for (const file of routeFiles(API_ROOT)) {
    const src = readFileSync(file, "utf8");
    // Identifiers bound to a parse result. Both call styles are in the tree:
    // `schema.safeParse(body)` and the standalone `z.safeParse(schema, body)`.
    const parsed = new Set<string>();
    for (const m of src.matchAll(
      /(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*(?:await\s+)?[^;]*?safeParse\s*\(/g,
    )) {
      parsed.add(m[1]);
    }
    if (parsed.size === 0) continue;

    for (const m of src.matchAll(
      /if\s*\(\s*!\s*([A-Za-z0-9_$]+)\.success\s*\)/g,
    )) {
      if (!parsed.has(m[1])) continue;
      const block = refusalBlock(src, (m.index ?? 0) + m[0].length);
      if (!/\b422\b/.test(block)) continue;
      sites.push({
        route: relative(process.cwd(), file).split(sep).join("/"),
        line: src.slice(0, m.index).split("\n").length,
        carriesIssues: /returnAllZodIssues|apiValidationError/.test(block),
      });
    }
  }
  return sites;
}

describe("Zod shape refusals carry the issue list", () => {
  const sites = scanRefusalSites();

  it("finds the refusal sites it is meant to judge", () => {
    // A matcher that stops matching would otherwise report a clean zero it did
    // not earn. The tree carried 59 of these when the guard was written; the
    // floor is deliberately loose so ordinary route churn does not trip it.
    expect(sites.length).toBeGreaterThan(40);
  });

  it("answers every 422 with details.issues", () => {
    const missing = sites
      .filter((site) => !site.carriesIssues && !(site.route in ALLOWLIST))
      .map((site) => `${site.route}:${site.line}`);
    expect(missing).toEqual([]);
  });

  it("keeps no stale allowlist entries", () => {
    const stale = Object.keys(ALLOWLIST).filter(
      (route) => !sites.some((site) => site.route === route),
    );
    expect(stale).toEqual([]);
  });
});

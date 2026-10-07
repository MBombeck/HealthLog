/**
 * Guard: every measurement read on the MCP surface and in the Coach tools
 * reads live rows only.
 *
 * A deleted measurement is a tombstone (`deletedAt` set), not a missing row.
 * Two presence probes on the MCP side (`metricStatusDiscoveryRows` and the
 * `search` clinical-signal probe) grouped by type without `deletedAt: null`:
 * a type whose readings had all been deleted still counted as present, and
 * because the live-rows partial index (`measurements_live_covering_idx`,
 * `WHERE deleted_at IS NULL`) only serves a query that carries the same
 * predicate, the probe walked every tombstone of the account (about a second
 * against 23 ms on a large production record).
 *
 * The guard reads the source of both trees, finds every
 * `prisma.measurement.<read>(` call, takes its argument up to the matching
 * parenthesis, and asserts the argument names `deletedAt`. Unique-key
 * lookups (`findUnique`) are idempotency checks on a key a tombstone still
 * holds, and are left out on purpose. Raw SQL against `measurements` must
 * carry `deleted_at` the same way.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = ["src/lib/mcp", "src/lib/ai/coach/tools"];
const READS =
  /\bprisma\.measurement\.(findMany|findFirst|count|groupBy|aggregate)\s*\(/g;
const RAW = /\b(?:FROM|JOIN)\s+"?measurements"?\b/gi;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "__tests__" ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The text from `open` (an opening parenthesis) to its matching close. */
function balanced(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

interface Site {
  at: string;
  argument: string;
}

function readSites(): { calls: Site[]; raw: Site[] } {
  const calls: Site[] = [];
  const raw: Site[] = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(join(process.cwd(), root))) {
      const text = readFileSync(file, "utf8");
      const name = relative(process.cwd(), file);
      const lineOf = (index: number) => text.slice(0, index).split("\n").length;
      for (const match of text.matchAll(READS)) {
        const open = (match.index ?? 0) + match[0].length - 1;
        calls.push({
          at: `${name}:${lineOf(match.index ?? 0)}`,
          argument: balanced(text, open),
        });
      }
      for (const match of text.matchAll(RAW)) {
        // The statement around it: up to the closing backtick of the
        // tagged template the query lives in.
        const start = match.index ?? 0;
        const end = text.indexOf("`", start);
        raw.push({
          at: `${name}:${lineOf(start)}`,
          argument: text.slice(start, end === -1 ? undefined : end),
        });
      }
    }
  }
  return { calls, raw };
}

describe("measurement reads on the MCP surface and in the Coach tools", () => {
  const { calls, raw } = readSites();

  it("finds the reads it is meant to check", () => {
    // A matcher that matches nothing proves nothing: the two probes this
    // guard was written for, the rich-read counts and the availability
    // probe are all in these trees.
    expect(calls.length).toBeGreaterThanOrEqual(5);
    expect(raw.length).toBeGreaterThanOrEqual(1);
  });

  it("filters every Prisma read to live rows", () => {
    const missing = calls
      .filter((site) => !/\bdeletedAt\b/.test(site.argument))
      .map((site) => site.at);
    expect(missing).toEqual([]);
  });

  it("filters every raw read to live rows", () => {
    const missing = raw
      .filter((site) => !/\bdeleted_at\b/.test(site.argument))
      .map((site) => site.at);
    expect(missing).toEqual([]);
  });
});

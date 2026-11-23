/**
 * Structural guard: a TTL constant handed to the server cache says what the
 * cache does with it.
 *
 * `ServerCache` caps every entry at `PROCESS_CACHE_MAX_TTL_MS`, because the
 * cache is process-local and a worker's write cannot evict the web
 * process's entry (`server-cache-ttl-ceiling.test.ts`). A constant above the
 * ceiling would still read as six hours to the next person and be fifteen
 * minutes in effect, so every `*_TTL_MS` literal in a file that uses the
 * server cache must be at or below it. The matcher evaluates plain numeric
 * literals only (`6 * 60 * 60_000`); a constant built from another name is
 * left to the runtime cap.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { PROCESS_CACHE_MAX_TTL_MS } from "@/lib/cache/ttl-ceiling";
import {
  readSourceText,
  requireFloor,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");
const USES_CACHE =
  /@\/lib\/cache\/(?:server-cache|cached-at-revision|ttl-ceiling)\b/;
const TTL_CONST = /const\s+([A-Z][A-Z0-9_]*TTL[A-Z0-9_]*_MS)\s*=\s*([^;]+);/g;
const NUMERIC = /^[\d_\s*+()]+$/;

function evaluate(expr: string): number {
  return Function(
    `"use strict"; return (${expr.replace(/_/g, "")});`,
  )() as number;
}

describe("server-cache TTL constants stay under the ceiling", () => {
  const found: Array<{ file: string; name: string; ms: number }> = [];
  for (const file of walkSourceFiles(SRC, { floor: 1000 })) {
    if (file.includes("__tests__") || file.startsWith("generated/")) continue;
    const source = stripComments(readSourceText(join(SRC, file)));
    if (!USES_CACHE.test(source)) continue;
    for (const m of source.matchAll(TTL_CONST)) {
      const expr = m[2].trim();
      if (!NUMERIC.test(expr)) continue;
      found.push({ file, name: m[1], ms: evaluate(expr) });
    }
  }

  it("finds the cached readers' TTL constants", () => {
    requireFloor("server-cache TTL constants", found, 5);
  });

  it("no constant asks for more than the cache will keep", () => {
    const over = found
      .filter((c) => c.ms > PROCESS_CACHE_MAX_TTL_MS)
      .map((c) => `${c.file}: ${c.name} = ${c.ms} ms`);
    expect(over).toEqual([]);
  });
});

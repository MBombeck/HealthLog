/**
 * The key-rotation walks page by `id > last`, never by Prisma's cursor.
 *
 * `cursor: { id }, skip: 1` looks the last row of a page up again. When that
 * row was hard-deleted between pages, Prisma answers the next page with
 * nothing, the walk stops early, and the scan reports a corpus smaller than
 * the one on disk, which can read as "nothing left on the old key". The
 * library walk is proven against Postgres in
 * `tests/integration/encryption-corpus-cursor-row-deleted.test.ts`; the
 * rotation script calls `process.exit` on import and cannot be driven from a
 * test, so its walks are held to the same shape here.
 *
 * Mutation check: put `cursor: { id: cursor }, skip: 1` back in either file
 * and this goes red.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const WALKS = [
  "scripts/rotate-encryption-key.ts",
  "src/lib/crypto/encryption-corpus.ts",
] as const;

describe("rotation walks page by key", () => {
  it.each(WALKS)("%s pages with `id > last`, not cursor + skip", (path) => {
    const code = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/cursor\s*:\s*\{[^}]*\}\s*,\s*skip\s*:/);
    // Non-zero proof: the walk is still there and still pages by key.
    expect(code).toMatch(/\{\s*gt\s*:\s*cursor\s*\}/);
  });
});

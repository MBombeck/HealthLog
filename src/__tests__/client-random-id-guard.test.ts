/**
 * Browser-side code does not call `crypto.randomUUID()` directly.
 *
 * `randomUUID` is `[SecureContext]` in the Web Cryptography IDL, so it is
 * absent on a plain-HTTP origin — the LAN self-host case. A direct call
 * there throws `TypeError: crypto.randomUUID is not a function`, and the
 * two places it was reached from were both silent: the document-vault
 * upload threw inside a file-input change handler (a picker that appeared
 * to do nothing), and the client transport threw while assembling the
 * default `Idempotency-Key` for every `apiPost` / `apiPatch`.
 *
 * `randomId()` in `src/lib/random-id.ts` covers both contexts. This guard
 * keeps the class from coming back one call site at a time.
 *
 * Server-side files are exempt: Node's global `crypto` carries
 * `randomUUID` unconditionally, and `node:crypto` imports are unrelated.
 * The exemption is an explicit list, not a pattern, so a new browser file
 * cannot join it by accident.
 *
 * Limit, stated so the next reader does not over-trust it: the matcher is
 * textual. `const f = crypto["randomUUID"]` or a destructured
 * `const { randomUUID } = crypto` would slip it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");

/**
 * Pruned on purpose: the generated Prisma client, vendored dependencies, and
 * the suites themselves are not the tree under audit. The walk descends into
 * dot-prefixed directories, so `src/app/.well-known` stays inside the sweep —
 * `fs.globSync` would drop it.
 */
const SKIP_DIRS = new Set([
  "__tests__",
  "__mocks__",
  "node_modules",
  ".next",
  "generated",
]);

/**
 * Files that legitimately call the platform API directly, each because it
 * runs on the server where the property always exists.
 */
const SERVER_SIDE_EXEMPT = new Set([
  // Next middleware — runs on the edge runtime, never in the page.
  "src/proxy.ts",
  // The one module allowed to reach for the platform call.
  "src/lib/random-id.ts",
]);

/** A direct call, tolerant of whitespace between the parts. */
const DIRECT_CALL = /\bcrypto\s*\.\s*randomUUID\s*\(/;

/**
 * Comments are prose, not calls. Without this the guard fires on the very
 * doc comments that explain why the call was removed — a guard that its own
 * explanation trips is one the next reader deletes.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Every `.ts(x)` under `src/`, as a repo-relative POSIX path. */
function sourceFiles(dir: string = SRC, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      sourceFiles(p, out);
    } else if (
      (name.endsWith(".ts") || name.endsWith(".tsx")) &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".test.tsx")
    ) {
      out.push(relative(ROOT, p).split(sep).join("/"));
    }
  }
  return out.sort();
}

describe("client-side randomUUID guard", () => {
  it("sweeps a non-trivial number of files", () => {
    // Without this the suite would pass by matching nothing at all.
    expect(sourceFiles().length).toBeGreaterThan(500);
  });

  it("finds no direct crypto.randomUUID() outside the exempt set", () => {
    const offenders = sourceFiles().filter(
      (file) =>
        !SERVER_SIDE_EXEMPT.has(file) &&
        DIRECT_CALL.test(stripComments(readFileSync(join(ROOT, file), "utf8"))),
    );

    expect(offenders).toEqual([]);
  });

  it("still matches the call it is meant to catch", () => {
    // The matcher's own positive control — a guard that cannot fire is
    // indistinguishable from a clean tree.
    expect(DIRECT_CALL.test('headers.set("k", crypto.randomUUID());')).toBe(
      true,
    );
    expect(DIRECT_CALL.test("const id = crypto . randomUUID ()")).toBe(true);
    expect(DIRECT_CALL.test("const id = randomId();")).toBe(false);
    // …and does not fire on prose about the call.
    expect(
      DIRECT_CALL.test(
        stripComments("/**\n * it did so with crypto.randomUUID().\n */"),
      ),
    ).toBe(false);
    expect(
      DIRECT_CALL.test(stripComments("// const id = crypto.randomUUID();")),
    ).toBe(false);
  });

  it("keeps every exempt file real and still calling it", () => {
    for (const file of SERVER_SIDE_EXEMPT) {
      const source = stripComments(readFileSync(join(ROOT, file), "utf8"));
      expect(
        DIRECT_CALL.test(source),
        `${file} no longer needs the exemption`,
      ).toBe(true);
    }
  });
});

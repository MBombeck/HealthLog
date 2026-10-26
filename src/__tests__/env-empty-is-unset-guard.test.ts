/**
 * Structural guard: an environment variable with a fallback is read through
 * `src/lib/env.ts`, never as `process.env.NAME ?? fallback`.
 *
 * ## The failure this freezes
 *
 * `docker-compose.yml` forwards its whitelist as `"${NAME:-}"`, so every
 * listed variable the operator left unset arrives as the empty string. `??`
 * only replaces `null` and `undefined`, so the empty string wins and the
 * fallback never applies. On a stock compose stack that sent Withings an
 * OAuth `redirect_uri=""`, handed the weather client an empty base URL
 * (`ERR_INVALID_URL` on every fetch) and pointed the IP geo lookup at a
 * relative path. The same shape with a method in between,
 * `process.env.NAME?.replace(...) ?? fallback`, fails the same way.
 *
 * ## What it proves and what it does not
 *
 * It proves no source file under `src/` writes a nullish fallback directly
 * against a `process.env` read. It does not see a read stored in a local
 * first and defaulted later (`const x = process.env.NAME; x ?? y`); those
 * stay a review question. `||` is allowed: it already treats the empty
 * string as unset, and client components need a literal
 * `process.env.NEXT_PUBLIC_X` for build-time inlining.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/**
 * `process.env.NAME` or `process.env["NAME"]`, optionally followed by
 * optional-chained calls such as `?.trim()` or `?.replace(/x/, "")`, then
 * `??` across any whitespace including a line break.
 */
const NULLISH_ENV_FALLBACK =
  /process\.env(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\s*["'`][A-Za-z_][A-Za-z0-9_]*["'`]\s*\])(?:\?\.[A-Za-z_]+\((?:[^()]|\([^()]*\))*\))*\s*\?\?/g;

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((rel) => !rel.startsWith("generated/"))
    .filter((rel) => !rel.includes("__tests__"))
    .filter((rel) => !rel.endsWith(".test.ts") && !rel.endsWith(".test.tsx"))
    .filter((rel) => rel !== "lib/env.ts");
}

function offenders(): string[] {
  return sourceFiles().filter((rel) => {
    const src = readFileSync(join(SRC, rel), "utf8");
    return [...src.matchAll(NULLISH_ENV_FALLBACK)].length > 0;
  });
}

describe("an empty environment variable counts as unset", () => {
  it("T1 — the matcher catches every shape it claims to", () => {
    const shapes = [
      `const a = process.env.FOO ?? "x";`,
      `const b = process.env.FOO\n    ?? "x";`,
      `const c = process.env["FOO"] ?? "x";`,
      `const d = process.env.FOO?.replace(/\\/$/, "") ?? "x";`,
      `const e = process.env.FOO?.trim()?.toLowerCase() ?? "x";`,
    ];
    for (const shape of shapes) {
      expect(
        [...shape.matchAll(NULLISH_ENV_FALLBACK)].length,
        shape,
      ).toBeGreaterThan(0);
    }
    for (const allowed of [
      `const f = process.env.FOO || "x";`,
      `const g = envOr("FOO", "x");`,
      `const h = process.env.FOO === "1" ? a ?? b : c;`,
    ]) {
      expect([...allowed.matchAll(NULLISH_ENV_FALLBACK)], allowed).toEqual([]);
    }
  });

  it("T2 — no source file defaults a process.env read with ??", () => {
    expect(
      offenders(),
      "Read these through envValue/envOr/envFlag from @/lib/env. Compose " +
        "passes an unset variable as the empty string, and ?? keeps it.",
    ).toEqual([]);
  });

  it("T3 — the sweep read the tree and the matcher fires on real source", () => {
    // An empty offender list proves nothing if the narrowed walk found no
    // files, or if the matcher no longer fires on what the tree actually
    // holds. Floor the narrowed set, then put the pre-fix read back into the
    // redirect-URI helper every client uses and require the matcher to find it there.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(2400);
    expect(files).toContain("lib/integrations/oauth-kit/redirect-uri.ts");
    const real = readFileSync(
      join(SRC, "lib/integrations/oauth-kit/redirect-uri.ts"),
      "utf8",
    );
    expect([...real.matchAll(NULLISH_ENV_FALLBACK)]).toEqual([]);
    const reverted = real.replace(
      /envOr\(envVar,/,
      "process.env.WITHINGS_REDIRECT_URI ?? (",
    );
    expect(reverted).not.toBe(real);
    expect([...reverted.matchAll(NULLISH_ENV_FALLBACK)].length).toBeGreaterThan(
      0,
    );
  });
});

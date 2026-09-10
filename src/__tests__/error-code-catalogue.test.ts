/**
 * The published `meta.errorCode` list is the list the server actually emits.
 *
 * `meta.errorCode` is the mechanism this API chose for machine-readable errors
 * and the envelope tells a client to branch on it — but of the two hundred and
 * forty-two codes in the tree, sixteen appeared anywhere in the contract. A
 * client had to discover each one by triggering the error, and had no way at
 * all to learn a new one had appeared. The catalogue publishes them; this holds
 * the catalogue to the code, in both directions:
 *
 *   - A code emitted and not listed is today's defect repeating itself, and it
 *     is also how a fifth naming convention would get in unnoticed.
 *   - A code listed and no longer emitted is a promise the server stopped
 *     keeping, which is worse than an omission: a client can write a branch for
 *     it and wait forever.
 *
 * What it reads: every `.ts` under `src/app/api` outside a `__tests__`
 * directory, and then every module those files import, transitively, so a code
 * built one or five hops away from the route that answers with it is read
 * where it is written. Import specifiers are resolved the way the app resolves
 * them (`@/…` and relative paths, `.ts` / `.tsx` / `index.*`); anything that
 * leaves `src` is not followed, and the generated Prisma client is never
 * opened. Comment lines are stripped first, so a code quoted in prose is not
 * mistaken for one that ships.
 *
 * This used to be the route tree plus a hand-kept list of library modules, and
 * the hand-kept list is exactly what it sounds like: the dose-history import
 * built five codes in a module nobody had thought to add, so the guard read
 * neither the codes nor the file and agreed the catalogue was complete. The
 * import graph is not hand-kept — a new module reached by a route is swept the
 * first time a route imports it.
 *
 * Its limits, stated rather than implied. A code assembled at runtime from a
 * template cannot be enumerated at all, and the one family that does so is
 * named in the catalogue's own doc comment. A code that reaches the envelope
 * through a variable is found where the values are declared, which means a
 * literal in a constant the sweep's shapes do not cover would still be missed:
 * a constant that holds wire codes is named `*_CODE` / `*_CODES` for that
 * reason. And `IntegrationStatus.errorCode` is a different field with the same
 * name — it records an upstream HTTP status in the sync ledger and never
 * reaches a response — so the two ledger writers that take it are cut out of
 * the text before it is matched.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { ERROR_CODE_CATALOGUE } from "@/lib/openapi/error-codes";

const SRC_ROOT = join(process.cwd(), "src");
const APP_ROOT = join(SRC_ROOT, "app");
/** Never opened: the generated Prisma client is megabytes of machine output. */
const GENERATED_ROOT = join(SRC_ROOT, "generated");

/**
 * The sync ledger's writers. `IntegrationStatus.errorCode` records an upstream
 * HTTP status and never reaches a response envelope, so their arguments are cut
 * out before a code is looked for. A third writer would surface as an
 * undocumented code rather than as silence, which is the direction to fail in.
 */
const LEDGER_WRITERS = ["recordSyncFailure", "parkIntegrationAtReauth"];

function tsFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      found.push(...tsFiles(full));
      continue;
    }
    if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

/** Resolve one import specifier the way the app's path alias resolves it. */
function resolveSpecifier(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(SRC_ROOT, specifier.slice(2));
  else if (specifier.startsWith("."))
    base = resolve(dirname(fromFile), specifier);
  else return null;
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every module a route reaches, however many hops away it is written. */
function modulesUnderTheRoutes(): string[] {
  const queue = tsFiles(APP_ROOT);
  const seen = new Set(queue);
  for (let i = 0; i < queue.length; i++) {
    const file = queue[i];
    const source = readFileSync(file, "utf8");
    const specifiers = [
      ...source.matchAll(
        /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s*"([^"]+)"/g,
      ),
      ...source.matchAll(/import\(\s*"([^"]+)"\s*\)/g),
    ];
    for (const match of specifiers) {
      const resolved = resolveSpecifier(match[1], file);
      if (!resolved) continue;
      if (resolved.startsWith(GENERATED_ROOT)) continue;
      if (resolved.includes(`${sep}__tests__${sep}`)) continue;
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push(resolved);
    }
  }
  return [...seen];
}

/** Cut the sync-ledger writers' arguments out, parenthesis-balanced. */
function withoutLedgerWrites(source: string): string {
  let text = source;
  for (const writer of LEDGER_WRITERS) {
    for (;;) {
      const call = text.indexOf(`${writer}(`);
      if (call === -1) break;
      const open = call + writer.length;
      let depth = 0;
      let close = text.length;
      for (let j = open; j < text.length; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")") {
          depth--;
          if (depth === 0) {
            close = j + 1;
            break;
          }
        }
      }
      text = text.slice(0, call) + text.slice(close);
    }
  }
  return text;
}

/** Drop comment lines so a code quoted in prose is not read as one that ships. */
function withoutComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !(
        trimmed.startsWith("*") ||
        trimmed.startsWith("//") ||
        trimmed.startsWith("/*")
      );
    })
    .join("\n");
}

/** The shapes a code is written in across the tree. */
function codesIn(source: string): string[] {
  const found: string[] = [];
  // `errorCode: "x"`, `errorCode = "x"`, `readonly errorCode = "x"`, and the
  // annotated `errorCode: string = "x"` on the step-up error's constructor.
  for (const m of source.matchAll(
    /errorCode\s*(?::\s*[A-Za-z.[\]|" ]+)?\s*[:=]\s*"([^"]+)"/g,
  )) {
    found.push(m[1]);
  }
  // A single shared constant: `export const MODULE_DISABLED_ERROR_CODE = "…"`.
  for (const m of source.matchAll(/\b[A-Z][A-Z0-9_]*_CODE\s*=\s*"([^"]+)"/g)) {
    found.push(m[1]);
  }
  // A family in one object: `export const AUTH_ERROR_CODES = { … }`, or in one
  // tuple: `export const AUTO_EXPORT_FATAL_ERROR_CODES = [ … ] as const`. The
  // tuple is how a union type of codes is declared, and that union is what an
  // envelope relays when it writes `errorCode: parsed.fatal.reason`. Only the
  // `_ERROR_CODES` spelling is read in tuple form: plenty of unrelated
  // catalogues (nutrients, say) are lists of codes that are not error codes.
  for (const m of source.matchAll(/\b([A-Z][A-Z0-9_]*_CODES)\s*=\s*([{[])/g)) {
    const [, name, opener] = m;
    if (opener === "[" && !name.endsWith("_ERROR_CODES")) continue;
    const closer = opener === "{" ? "}" : "]";
    const start = source.indexOf(opener, m.index);
    let depth = 0;
    let end = start;
    for (let j = start; j < source.length; j++) {
      if (source[j] === opener) depth++;
      else if (source[j] === closer) {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    const body = source.slice(start, end);
    const values =
      opener === "{"
        ? body.matchAll(/:\s*"([^"]+)"/g)
        : body.matchAll(/"([^"]+)"/g);
    for (const value of values) found.push(value[1]);
  }
  return found;
}

/** Every code the tree emits, mapped to the files that emit it. */
function emittedCodes(): Map<string, string[]> {
  const emitted = new Map<string, string[]>();
  for (const file of modulesUnderTheRoutes()) {
    const source = withoutLedgerWrites(
      withoutComments(readFileSync(file, "utf8")),
    );
    for (const code of codesIn(source)) {
      const where = relative(process.cwd(), file).split(sep).join("/");
      const seen = emitted.get(code);
      if (seen) {
        if (!seen.includes(where)) seen.push(where);
      } else {
        emitted.set(code, [where]);
      }
    }
  }
  return emitted;
}

const emitted = emittedCodes();
const published = new Set(Object.values(ERROR_CODE_CATALOGUE).flat());

describe("the published errorCode catalogue", () => {
  it("finds the codes it is meant to judge", () => {
    // A matcher that stopped matching would otherwise agree with an empty
    // catalogue. Two hundred and twenty-nine when this was written, read out
    // of the fourteen hundred modules the route tree reaches.
    expect(emitted.size).toBeGreaterThan(200);
  });

  it("lists every code the server emits", () => {
    const undocumented = [...emitted.entries()]
      .filter(([code]) => !published.has(code))
      .map(([code, files]) => `${code} (${files[0]})`)
      .sort();
    expect(undocumented).toEqual([]);
  });

  it("emits every code it lists", () => {
    const stale = [...published].filter((code) => !emitted.has(code)).sort();
    expect(stale).toEqual([]);
  });

  it("files every code under the surface its own prefix names", () => {
    const misfiled: string[] = [];
    for (const [surface, codes] of Object.entries(ERROR_CODE_CATALOGUE)) {
      for (const code of codes) {
        const expected = code.includes(".")
          ? code.slice(0, code.indexOf("."))
          : "(unprefixed)";
        if (expected !== surface) misfiled.push(`${code} under ${surface}`);
      }
    }
    expect(misfiled).toEqual([]);
  });

  it("keeps no duplicate between two surfaces", () => {
    const all = Object.values(ERROR_CODE_CATALOGUE).flat();
    expect(all.length).toBe(new Set(all).size);
  });
});

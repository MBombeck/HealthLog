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
 * directory, plus the named library modules that build a refusal envelope of
 * their own. Comment lines are stripped first, so a code quoted in prose is not
 * mistaken for one that ships.
 *
 * Its limits, stated rather than implied. A new library module that raises a
 * coded refusal has to be added to `ENVELOPE_MODULES` below — the route tree is
 * swept by rule, that list is not. A code assembled at runtime from a template
 * cannot be enumerated at all, and the one family that does so is named in the
 * catalogue's own doc comment. And `IntegrationStatus.errorCode` is a different
 * field with the same name — it records an upstream HTTP status in the sync
 * ledger and never reaches a response — which is why the sweep is scoped to
 * the modules that answer requests rather than to `src/lib` wholesale.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { ERROR_CODE_CATALOGUE } from "@/lib/openapi/error-codes";

const API_ROOT = join(process.cwd(), "src", "app", "api");

/**
 * Library modules that build a coded refusal without going through a route
 * file. Everything else under `src/lib` is out of scope on purpose — see the
 * note on `IntegrationStatus.errorCode` in the file header.
 */
const ENVELOPE_MODULES = [
  "src/lib/ai/consent-guard.ts",
  "src/lib/api-errors.ts",
  "src/lib/api-handler.ts",
  "src/lib/auth/profile-update.ts",
  "src/lib/clinician-share/report-download.ts",
  "src/lib/cycle/gate.ts",
  "src/lib/documents/ai-route-support.ts",
  "src/lib/documents/attach-validate.ts",
  "src/lib/export/backup-blob.ts",
  "src/lib/http/retired-routes.ts",
  "src/lib/illness/gate.ts",
  "src/lib/modules/gate.ts",
  "src/lib/optimistic-lock.ts",
  "src/lib/sharing/record-session-fence-contract.ts",
];

function apiFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      found.push(...apiFiles(full));
      continue;
    }
    if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
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

/** The three shapes a code is written in across the tree. */
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
  // A family in one object: `export const AUTH_ERROR_CODES = { … }`.
  for (const m of source.matchAll(/\b[A-Z][A-Z0-9_]*_CODES\s*=\s*\{/g)) {
    const start = source.indexOf("{", m.index);
    let depth = 0;
    let end = start;
    for (let j = start; j < source.length; j++) {
      if (source[j] === "{") depth++;
      else if (source[j] === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    for (const value of source.slice(start, end).matchAll(/:\s*"([^"]+)"/g)) {
      found.push(value[1]);
    }
  }
  return found;
}

/** Every code the tree emits, mapped to the files that emit it. */
function emittedCodes(): Map<string, string[]> {
  const emitted = new Map<string, string[]>();
  const files = [
    ...apiFiles(API_ROOT),
    ...ENVELOPE_MODULES.map((path) => join(process.cwd(), path)),
  ];
  for (const file of files) {
    const source = withoutComments(readFileSync(file, "utf8"));
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
    // catalogue. Two hundred and forty-two when this was written.
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

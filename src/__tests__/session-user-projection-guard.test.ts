/**
 * The caller lookups load a projection of `User`, never the whole row.
 *
 * Every authenticated request resolves its caller through the session lookup
 * (`lib/auth/session.ts`), the Bearer resolver (`lib/auth/bearer.ts`) or, for a
 * switched record, the owner load in `lib/auth/guards/record.ts`. They used to
 * `include: { user: true }` / `findUnique({ where })`, which copied the profile
 * picture (megabytes), the cached briefing text and every stored credential
 * into memory on each request. They now name `SESSION_USER_SELECT`.
 *
 * Two halves:
 *   1. each of those lookups carries the projection, and no file anywhere loads
 *      a related user row whole with `include: { user: true }`;
 *   2. the projection itself leaves out every `Bytes` column of the model and
 *      every secret-shaped column, derived from `schema.prisma` so a new
 *      column of either kind is covered without editing this file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { guardModuleOf } from "./helpers/auth-guards";
import { stripComments, walkSourceFiles } from "./helpers/source-files";
import { SESSION_USER_SELECT } from "@/lib/auth/session-user";

const SRC = join(process.cwd(), "src");

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

/** The `{ ... }` argument of every call matching `callee`, braces balanced. */
function callObjects(src: string, callee: RegExp): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  const re = new RegExp(callee.source + /\s*\(\s*\{/.source, "g");
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let i = open;
    for (; i < code.length; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}" && --depth === 0) break;
    }
    out.push(code.slice(open, i + 1));
  }
  return out;
}

const USER_LOOKUP = /prisma\.user\.find(?:Unique|First)(?:OrThrow)?/;
const SESSION_LOOKUP = /prisma\.session\.find(?:Unique|First)(?:OrThrow)?/;

describe("caller lookups load the session projection", () => {
  it("the session lookups include the user through SESSION_USER_SELECT", () => {
    const calls = callObjects(
      read("lib/auth/session.ts"),
      SESSION_LOOKUP,
    ).filter((body) => /\binclude\s*:/.test(body));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const body of calls) {
      expect(body).toMatch(
        /include\s*:\s*\{\s*user\s*:\s*\{\s*select\s*:\s*SESSION_USER_SELECT\s*\}\s*\}/,
      );
    }
  });

  it("the Bearer resolver and the switched-owner load select SESSION_USER_SELECT", () => {
    for (const rel of [
      "lib/auth/bearer.ts",
      guardModuleOf("resolveSwitchedRecord"),
    ]) {
      const calls = callObjects(read(rel), USER_LOOKUP);
      expect(calls.length, rel).toBeGreaterThan(0);
      for (const body of calls) {
        expect(body, rel).toMatch(/\bselect\s*:/);
      }
      expect(
        calls.some((body) => /select\s*:\s*SESSION_USER_SELECT\b/.test(body)),
        rel,
      ).toBe(true);
    }
  });

  it("no file loads a related user row whole", () => {
    const files = walkSourceFiles(SRC, { floor: 3000 })
      .filter((p) => !p.startsWith("generated/"))
      .filter((p) => !p.includes("__tests__"))
      .filter((p) => !/\.test\.tsx?$/.test(p));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((rel) =>
      /\buser\s*:\s*true\b/.test(
        stripComments(read(rel)).replace(/select\s*:\s*\{[^{}]*\}/g, ""),
      ),
    );
    expect(offenders).toEqual([]);
  });
});

describe("SESSION_USER_SELECT leaves out bytes and secrets", () => {
  const schema = readFileSync(
    join(process.cwd(), "prisma", "schema.prisma"),
    "utf8",
  );
  const model = schema.match(/^model User \{([\s\S]*?)^\}/m)?.[1] ?? "";
  const columns = [
    ...model.matchAll(/^\s+(\w+)\s+([A-Z]\w*)(\??)(?:\s|$)/gm),
  ].map(([, name, type]) => ({ name, type }));
  const selected = Object.keys(SESSION_USER_SELECT);

  it("reads the User model", () => {
    expect(columns.length).toBeGreaterThan(50);
    expect(selected.length).toBeGreaterThan(0);
  });

  it("names only columns the model has", () => {
    const names = new Set(columns.map((c) => c.name));
    expect(selected.filter((key) => !names.has(key))).toEqual([]);
  });

  it("selects no Bytes column", () => {
    const bytes = columns.filter((c) => c.type === "Bytes").map((c) => c.name);
    expect(bytes).toContain("avatarBytes");
    expect(selected.filter((key) => bytes.includes(key))).toEqual([]);
  });

  it("selects no credential, secret or large cached text", () => {
    const secretShaped =
      /Encrypted$|^passwordHash$|^totpSecret|^totpLastStep$|^telegramBotToken$|^environmentAqHistoryJson$/;
    const secrets = columns
      .map((c) => c.name)
      .filter((name) => secretShaped.test(name));
    expect(secrets.length).toBeGreaterThan(10);
    expect(selected.filter((key) => secrets.includes(key))).toEqual([]);
  });
});

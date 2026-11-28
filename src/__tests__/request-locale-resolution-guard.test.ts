/**
 * Structural guard: text translated during a request takes its language from
 * the request, through `resolveServerLocale`, never from the stored
 * `User.locale` alone.
 *
 * An account that never picked a language has a NULL `User.locale`. A route
 * that translated with `resolveJobLocale(user.locale)` or
 * `coerceLocale(user.locale)` answered such an account in English, whatever
 * language the app or the browser asked for in `Accept-Language`: the series
 * reference lines, the dashboard summary greeting and the built-in symptom
 * labels all reached a German phone in English. `resolveServerLocale`
 * (`src/lib/i18n/server-locale.ts`) is the one request-side ladder; the
 * stored language is one rung of it and `Accept-Language` the next.
 * `resolveJobLocale` stays the background paths' answer, because a job has
 * no request to read.
 *
 * Three tripwires over the request-path files (every module under `src/app`
 * plus the request-only libraries listed below), none of them a proof:
 *
 *   T1 — no request-path file imports `@/lib/i18n/job-locale`.
 *   T2 — no request-path file applies a bare validator to a row's locale
 *        column (`coerceLocale(user.locale)`, `isLocale(row?.locale)`), and no
 *        `getServerTranslator(...)` call reads a row's `.locale` in its
 *        argument.
 *   T3 — every `src/app` file that calls `getServerTranslator` imports a
 *        request resolver, or is listed as taking its locale from its caller.
 *
 * What slips past: a column copied into a local first and translated from
 * there, or a library outside the list below that a route hands a raw
 * column. The matchers are grep-shaped on purpose; a reviewer still reads the
 * diff.
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";

import { readSourceText, walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/**
 * Libraries that only ever run inside a request and translate there. Their
 * locale is the caller's, resolved from the request.
 */
const REQUEST_LIBS = [
  "lib/dashboard/summary/build.ts",
  "lib/measurements/series/read-series.ts",
  "lib/push-relay/test-push.ts",
  "lib/symptoms/apple-health-ingest.ts",
] as const;

function requestFiles(): string[] {
  const app = walkSourceFiles(join(SRC, "app"), { floor: 500 })
    .filter((rel) => !rel.includes("__tests__"))
    .filter((rel) => !/\.test\.tsx?$/.test(rel))
    .map((rel) => `app/${rel}`);
  return [...app, ...REQUEST_LIBS].sort();
}

function read(rel: string): string {
  return readSourceText(join(SRC, rel));
}

/**
 * Receivers whose `.locale` is a value the request supplied or a caller
 * already resolved, not a database row.
 */
const RESOLVED_RECEIVERS = new Set([
  "input",
  "options",
  "opts",
  "args",
  "params",
  "payload",
  "data",
  "parsed",
  "body",
  "ctx",
]);

/** The argument text of every `getServerTranslator(...)` call, parens balanced. */
function translatorArguments(text: string): string[] {
  const out: string[] = [];
  const marker = "getServerTranslator(";
  let from = 0;
  for (;;) {
    const at = text.indexOf(marker, from);
    if (at < 0) return out;
    let depth = 1;
    let i = at + marker.length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
    }
    out.push(text.slice(at + marker.length, i - 1));
    from = i;
  }
}

const ROW_LOCALE = /\b([A-Za-z_$][\w$]*)\??\.locale\b/g;
const BARE_VALIDATOR =
  /\b(?:isLocale|coerceLocale|normalizeLocale|resolveLocale)\(\s*(?:[\w$]+\??\.)*([\w$]+)\??\.locale\s*\)/g;

/**
 * Files under `src/app` that translate with a locale handed to them, and so
 * import no resolver of their own. Each names who resolves it.
 */
const TAKES_LOCALE = [
  // A component: `src/app/layout.tsx` resolves the locale and passes it in.
  "app/key-mismatch-page.tsx",
];

/** Modules that resolve a request's language. */
const REQUEST_RESOLVER =
  /from "@\/lib\/(?:i18n\/server-locale|i18n\/resolve-initial-locale|i18n\/user-locale|clinician-share\/request-locale)"/;

describe("request-time text resolves its language from the request", () => {
  const files = requestFiles();
  const translating = files.filter((rel) =>
    read(rel).includes("getServerTranslator("),
  );

  it("walks the request tree and finds the translating files", () => {
    expect(files.length).toBeGreaterThan(500);
    // The sweep only means something if it finds the call sites.
    expect(translating.length).toBeGreaterThan(25);
  });

  it("T1 — no request-path file imports resolveJobLocale", () => {
    const offenders = files.filter((rel) =>
      /from "@\/lib\/i18n\/job-locale"/.test(read(rel)),
    );
    expect(offenders).toEqual([]);
  });

  it("T2 — no request-path file translates from a bare stored locale column", () => {
    const offenders: string[] = [];
    for (const rel of files) {
      const text = read(rel);
      if (!text.includes("getServerTranslator(")) continue;
      for (const match of text.matchAll(BARE_VALIDATOR)) {
        if (!RESOLVED_RECEIVERS.has(match[1])) {
          offenders.push(`${rel}: ${match[0]}`);
        }
      }
      for (const arg of translatorArguments(text)) {
        // A column handed to the request resolver is one rung of its ladder.
        if (arg.includes("resolveServerLocale(")) continue;
        for (const match of arg.matchAll(ROW_LOCALE)) {
          if (!RESOLVED_RECEIVERS.has(match[1])) {
            offenders.push(`${rel}: getServerTranslator(${arg.trim()})`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("T3 — every src/app file that translates imports a request resolver", () => {
    const offenders = translating
      .filter((rel) => rel.startsWith("app/"))
      .filter((rel) => !TAKES_LOCALE.includes(rel))
      .filter((rel) => !REQUEST_RESOLVER.test(read(rel)));
    expect(offenders).toEqual([]);
    // The allowlist must not outlive its entries.
    for (const rel of TAKES_LOCALE) expect(translating).toContain(rel);
  });
});

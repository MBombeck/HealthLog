/**
 * Every read-failure primitive is handed the error it reports.
 *
 * `QueryErrorRow`, `QueryErrorCard` and `ChartErrorState` decide what a failed read offers from
 * the error itself: nothing (or the surface's refused state) for a 403, a
 * note without a retry for a 429, sign-in for a 401, a retry otherwise. A
 * call site that renders one without the error falls back to "failed" for
 * every status, which is how a refused share showed an error card and a spent
 * budget offered a retry that could only be refused again.
 *
 * The prop is required in the type, so the compiler already catches a missing
 * one. What it cannot catch is a literal that defeats it (`error={null}`,
 * `error={undefined}`), so this guard reads every opening tag under `src/`
 * and refuses both. The matcher is whitespace-tolerant (tags span lines) and
 * the match count is asserted, so a matcher that stops finding the tags fails
 * rather than passing over nothing.
 *
 * Handing the error over is only half of it: the error has to still be the
 * `ApiError` the read threw. A `queryFn` that catches it and throws
 * `new Error(t("…loadError"))` instead strips the status, so every primitive
 * downstream reads "failed" and an ended session offers a retry. The second
 * block reads every `queryFn` value under `src/` (`.ts` and `.tsx`, since
 * query hooks live in both and a cache key is shared across files) and
 * refuses a catch that re-throws a plain `Error`, or a translated message
 * thrown in its place. The message belongs on the primitive (`message` /
 * `title`), not inside the error.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./helpers/source-files";

const SRC = join(__dirname, "..");

function walk(
  dir: string,
  out: string[] = [],
  ext: RegExp = /\.tsx$/,
): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "generated") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out, ext);
    else if (ext.test(entry.name) && !entry.name.includes(".test."))
      out.push(path);
  }
  return out;
}

/** The opening tag's attribute text, from the name to its closing `>`. */
function openingTags(source: string): string[] {
  const tags: string[] = [];
  const open = /<(QueryErrorRow|QueryErrorCard|ChartErrorState)(?=[\s/>])/g;
  for (let m = open.exec(source); m; m = open.exec(source)) {
    let depth = 0;
    let i = m.index + m[0].length;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
    }
    tags.push(source.slice(m.index, i + 1));
  }
  return tags;
}

const sites = walk(SRC).flatMap((file) =>
  openingTags(stripComments(readFileSync(file, "utf8"))).map((tag) => ({
    file: relative(SRC, file),
    tag,
  })),
);

describe("read-failure primitives carry their error", () => {
  it("finds the call sites it guards", () => {
    // About 120 at the time of writing. A drop to a handful means the
    // matcher broke, not that the sites went away.
    expect(sites.length).toBeGreaterThan(100);
  });

  it("passes the query's error at every site", () => {
    const offenders = sites
      .filter(
        ({ tag }) =>
          !/\serror=\{/.test(tag) ||
          /\serror=\{\s*(null|undefined)\s*\}/.test(tag),
      )
      .map(({ file, tag }) => `${file}: ${tag.split("\n")[0]}`);
    expect(offenders).toEqual([]);
  });
});

/**
 * The text of every `queryFn` value: from the key to the comma, or the
 * closing bracket, that ends the property at its own depth.
 */
function queryFnBodies(source: string): string[] {
  const bodies: string[] = [];
  const key = /\bqueryFn\s*:/g;
  for (let m = key.exec(source); m; m = key.exec(source)) {
    let depth = 0;
    let i = m.index + m[0].length;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") {
        if (depth === 0) break;
        depth--;
      } else if (ch === "," && depth === 0) break;
    }
    bodies.push(source.slice(m.index, i));
  }
  return bodies;
}

/** A catch that throws a plain Error, or a translated line thrown as one. */
function masksTheReadError(body: string): boolean {
  return (
    /\bcatch\b\s*(\([^)]*\))?\s*\{[^}]*\bthrow\s+new\s+Error\(/.test(body) ||
    /\bthrow\s+new\s+Error\(\s*t\(/.test(body)
  );
}

const queryFns = walk(SRC, [], /\.tsx?$/).flatMap((file) =>
  queryFnBodies(stripComments(readFileSync(file, "utf8"))).map((body) => ({
    file: relative(SRC, file),
    body,
  })),
);

describe("a read's ApiError reaches the primitive intact", () => {
  it("finds the queryFns it guards", () => {
    // About 310 at the time of writing.
    expect(queryFns.length).toBeGreaterThan(250);
  });

  it("recognises the masking shape it refuses", () => {
    expect(
      masksTheReadError(
        'queryFn: async () => { try { return await apiGet(u); } catch { throw new Error(t("x.loadError")); } }',
      ),
    ).toBe(true);
    expect(
      masksTheReadError(
        'queryFn: async () => { try { return await apiGet(u); } catch (e) { throw new Error("failed"); } }',
      ),
    ).toBe(true);
    expect(masksTheReadError("queryFn: () => apiGet(u)")).toBe(false);
    expect(
      masksTheReadError(
        'queryFn: async () => { if (!id) throw new Error("missing id"); return apiGet(u); }',
      ),
    ).toBe(false);
  });

  it("never swaps the read's error for a plain Error", () => {
    const offenders = queryFns
      .filter(({ body }) => masksTheReadError(body))
      .map(({ file, body }) => `${file}: ${body.split("\n")[0]}`);
    expect(offenders).toEqual([]);
  });
});

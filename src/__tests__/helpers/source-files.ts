/**
 * The one file walker the structural guards share.
 *
 * ## Why this exists rather than `fs.globSync`
 *
 * A guard that freezes a discovered set against an allowlist is only as
 * honest as its idea of "every source file". `fs.globSync` has a rule that
 * silently narrows that idea: a glob's `*` never matches a leading dot, so
 * `**\/*.{ts,tsx}` skips every dot-prefixed directory without saying so.
 *
 * `src/app/.well-known/` holds three live route modules — the two OAuth
 * discovery documents the MCP server publishes and the
 * apple-app-site-association handler. Every guard built on `globSync` walked
 * straight past all three and reported a clean sweep over a tree with a hole
 * in it. Demonstrated, not assumed: an unlisted `getSession()` call planted
 * in `app/.well-known/oauth-authorization-server/route.ts` left
 * `session-surface-guard` at 9 passed, and fails it once the walk goes
 * through here.
 *
 * `readdirSync(root, { recursive: true })` has no dot rule. It is the reason
 * `delegable-surface-guard.test.ts` already walks by hand; this helper makes
 * that the shared behaviour instead of one guard's private correction.
 *
 * ## Why `floor` is required and not optional
 *
 * The other way a sweep goes quiet is by finding nothing at all: an empty
 * match set agrees with an empty allowlist, and the guard passes on a tree it
 * never read. A wrong root, a renamed directory, or a walk that throws away
 * every entry all look exactly like compliance. So every caller states the
 * size it expects to walk, pinned below the real count with headroom, and a
 * walk that comes back smaller throws instead of reporting a clean sweep.
 * The floor covers the walk; a guard that filters further is still on the
 * hook for a floor over its own narrowed set.
 *
 * ## What it returns
 *
 * Posix-separated paths relative to `root`, sorted, so a guard's output and
 * its failure message read the same on every platform. Directory entries are
 * dropped by the extension filter.
 *
 * ## What it does not do
 *
 * It applies no exclusions of its own — not `generated/`, not `__tests__`,
 * not `.test.ts`. Each guard states its own, because what counts as out of
 * scope is the guard's claim to make, not the walker's.
 *
 * And it must not be rooted at the repository root. Descending into
 * dot-prefixed directories is the whole point, but at the root that means
 * `.git` and — on a maintainer's machine mid-release — the `.wt-*` sibling
 * worktrees, each a full second copy of the tree that would double every
 * match. Every caller roots at `src/`, `e2e/` or a subtree of one.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

// ── The shared source index ────────────────────────────────────────────────
//
// The guards walk and read the same tree, and the guards project shares one
// module graph per worker (`isolate: false`), so every walk and every read
// below is memoised for the life of the worker: the tree is listed once per
// top-level folder and each file is read once, however many guards ask. A
// guard that walked `src/` and read every file again for each pattern it
// tried ran for fifteen seconds; the same questions over the index take a
// fraction of one.
//
// Only folders of the repository that do not change while tests run are
// indexed (`INDEXED_ROOTS`). A walk or a read anywhere else (a temporary
// fixture tree a test writes and rewrites) goes to the disk every time.

const INDEXED_ROOTS = ["src", "e2e", "prisma"].map((dir) =>
  resolve(process.cwd(), dir),
);

function indexedRootOf(path: string): string | null {
  const absolute = resolve(path);
  return (
    INDEXED_ROOTS.find(
      (root) => absolute === root || absolute.startsWith(`${root}${sep}`),
    ) ?? null
  );
}

const listingCache = new Map<string, string[]>();

/** Every entry under `root`, posix-separated, sorted; memoised when indexed. */
function listTree(root: string): string[] {
  const absolute = resolve(root);
  const anchor = indexedRootOf(absolute);
  if (anchor === null) {
    return readdirSync(absolute, { recursive: true })
      .map((entry) => String(entry).split(sep).join("/"))
      .sort();
  }
  let all = listingCache.get(anchor);
  if (all === undefined) {
    all = readdirSync(anchor, { recursive: true })
      .map((entry) => String(entry).split(sep).join("/"))
      .sort();
    listingCache.set(anchor, all);
  }
  if (absolute === anchor) return all;
  const prefix = `${relative(anchor, absolute).split(sep).join("/")}/`;
  return all
    .filter((rel) => rel.startsWith(prefix))
    .map((rel) => rel.slice(prefix.length));
}

const textCache = new Map<string, string>();

/**
 * A repository file's text, read once per worker when it lies in an indexed
 * folder. Use it in place of `readFileSync(path, "utf8")` for source the
 * guard reads and never writes.
 */
export function readSourceText(path: string): string {
  const absolute = resolve(path);
  if (indexedRootOf(absolute) === null) return readFileSync(absolute, "utf8");
  let text = textCache.get(absolute);
  if (text === undefined) {
    text = readFileSync(absolute, "utf8");
    textCache.set(absolute, text);
  }
  return text;
}

export function walkSourceFiles(
  root: string,
  options: { floor: number; extensions?: readonly string[] },
): string[] {
  const extensions = options.extensions ?? [".ts", ".tsx"];
  const files = listTree(root).filter((rel) =>
    extensions.some((ext) => rel.endsWith(ext)),
  );

  if (files.length < options.floor) {
    throw new Error(
      `walkSourceFiles(${root}) found ${files.length} file(s) matching ` +
        `${extensions.join(", ")}, below the stated floor of ${options.floor}. ` +
        `A sweep this small is a broken walk, not a clean tree — check the ` +
        `root before lowering the floor.`,
    );
  }
  return files;
}

/**
 * A source file with its comments removed, read the way the compiler reads it.
 *
 * Shared rather than re-spelled per guard because the per-guard copies were
 * one or two regular expressions, and every spelling was wrong somewhere:
 *   - block comments stripped first, with one non-greedy pass, cannot tell a
 *     real opener from a `/*` inside a line comment. `src/app/mood/
 *     page-client.tsx` explains its gate with "Every `/api/mood-entries/*`
 *     route also enforces the gate", and that `/*` opened a fake block that
 *     swallowed the next 2.2 kB of real code, the module gate included;
 *   - a scanner that takes the first opener on a line still opens a block at
 *     a `/*` inside a string, which every e2e route glob (`"**\/api/*"`) has;
 *   - a line comment matched only at the start of a line keeps a trailing
 *     `// …` after code, and one matched anywhere eats `https://`.
 *
 * So the text is scanned once, left to right, knowing what the parser knows:
 * strings, template literals (with their `${…}` expressions, which may hold
 * comments), and regular expressions keep every character, and a `/*` or
 * `//` inside any of them opens nothing. A slash starts a regular expression
 * where the language allows one: after an operator, an opening bracket, a
 * keyword such as `return`, or at the start. Line breaks are kept, so a line
 * number read off the result is the file's own.
 *
 * It is a scanner, not the parser, and is held to the parser instead of
 * trusted: `strip-comments-parity.test.ts` strips every source file both
 * ways and fails on the first that differs. `//` right after a `:` is read
 * as part of a URL in JSX text, never as a comment. CSS, which has no line
 * comments, is stripped of its block comments only (pass its `fileName`).
 */
export function stripComments(source: string, fileName?: string): string {
  if (fileName?.endsWith(".css")) {
    return source.replace(/\/\*[\s\S]*?\*\//g, blankKeepingLines);
  }
  const text = source;
  const n = text.length;
  let out = "";
  let i = 0;
  // Template nesting: "template" for a template body, a number for the brace
  // depth of the `${…}` expression being read, restored when it closes.
  const stack: Array<"template" | number> = [];
  let depth = 0;
  while (i < n) {
    const top = stack[stack.length - 1];
    if (top === "template") {
      let j = i;
      while (
        j < n &&
        text[j] !== "`" &&
        !(text[j] === "$" && text[j + 1] === "{")
      ) {
        j += text[j] === "\\" ? 2 : 1;
      }
      out += text.slice(i, Math.min(j, n));
      if (j >= n) break;
      if (text[j] === "`") {
        stack.pop();
        out += "`";
        i = j + 1;
        continue;
      }
      stack.push(depth);
      depth = 0;
      out += "${";
      i = j + 2;
      continue;
    }

    SPECIAL.lastIndex = i;
    const found = SPECIAL.exec(text);
    if (!found) {
      out += text.slice(i);
      break;
    }
    const j = found.index;
    out += text.slice(i, j);
    const c = text[j];
    const next = text[j + 1];

    if (c === "/" && next === "/" && text[j - 1] !== ":") {
      const end = text.indexOf("\n", j);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === "/" && next === "*") {
      const close = text.indexOf("*/", j + 2);
      const end = close === -1 ? n : close + 2;
      out += blankKeepingLines(text.slice(j, end));
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      let end = j + 1;
      while (end < n && text[end] !== c && text[end] !== "\n") {
        end += text[end] === "\\" ? 2 : 1;
      }
      if (text[end] === c) end += 1;
      out += text.slice(j, end);
      i = end;
      continue;
    }
    if (c === "`") {
      stack.push("template");
      out += "`";
      i = j + 1;
      continue;
    }
    if (c === "/") {
      const end = regexMayStart(out) ? regexEnd(text, j) : -1;
      if (end !== -1) {
        out += text.slice(j, end);
        i = end;
        continue;
      }
      out += "/";
      i = j + 1;
      continue;
    }
    if (c === "{") {
      depth += 1;
    } else if (depth === 0 && typeof top === "number") {
      depth = stack.pop() as number;
    } else {
      depth -= 1;
    }
    out += c;
    i = j + 1;
  }
  return out;
}

const SPECIAL = /[/'"`{}]/g;
const WORD = /[A-Za-z_$0-9]/;
const REGEX_AFTER = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "void",
  "yield",
  "await",
  "delete",
  "instanceof",
  "new",
  "throw",
]);

function blankKeepingLines(comment: string): string {
  return comment.replace(/[^\n]/g, "");
}

/** Whether a `/` after this code starts a regular expression. */
function regexMayStart(code: string): boolean {
  let k = code.length - 1;
  while (k >= 0 && /\s/.test(code[k]!)) k -= 1;
  if (k < 0) return true;
  const last = code[k]!;
  if (REGEX_AFTER.has(last)) return true;
  if (!WORD.test(last)) return false;
  let start = k;
  while (start > 0 && WORD.test(code[start - 1]!)) start -= 1;
  return REGEX_KEYWORDS.has(code.slice(start, k + 1));
}

/** The end of the regular expression opening at `start`, or -1 if none. */
function regexEnd(text: string, start: number): number {
  let end = start + 1;
  let inClass = false;
  while (end < text.length && text[end] !== "\n") {
    const ch = text[end];
    if (ch === "\\") {
      end += 2;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      end += 1;
      while (end < text.length && /[a-z]/i.test(text[end]!)) end += 1;
      return end;
    }
    end += 1;
  }
  return -1;
}

/**
 * Asserts that a sweep found at least `floor` things, and returns them.
 *
 * `walkSourceFiles` puts a floor under the walk. This puts one under what a
 * guard does with it: the narrowed file set, the call sites a matcher picked
 * out, the routes an inventory extracted. A matcher that drifts out of step
 * with the code — a renamed helper, a call split across two lines, a regex
 * that stopped compiling the way it was meant to — returns an empty list, and
 * an empty list agrees with every allowlist and every "none of these may
 * exist" rule. That is how the Bearer-scope guard stayed green for weeks while
 * matching nothing.
 *
 * Pin `floor` at the real count when the set is a closed inventory, and below
 * it with headroom only when the count legitimately moves. A floor of zero is
 * refused: it is the bug this exists to prevent, spelled as a parameter.
 */
export function requireFloor<T>(
  label: string,
  found: readonly T[],
  floor: number,
): readonly T[] {
  if (!Number.isInteger(floor) || floor < 1) {
    throw new Error(
      `requireFloor(${label}): floor must be a positive integer, got ${floor}.`,
    );
  }
  if (found.length < floor) {
    throw new Error(
      `${label}: found ${found.length}, below the stated floor of ${floor}. ` +
        `A matcher that finds this little has drifted from the code it ` +
        `reads; fix the matcher before lowering the floor.`,
    );
  }
  return found;
}

export interface SourceMatch {
  /** Path relative to the scanned root, posix-separated. */
  file: string;
  /** 1-based line of the match start. */
  line: number;
  /** The matched text. */
  text: string;
}

/**
 * Walk `root`, run `pattern` over every kept file, and return each match —
 * with a floor on the files read AND a floor on the matches found.
 *
 * `pattern` must carry the `g` flag; it is the only way to report more than
 * one hit per file, and a non-global regex silently finding one hit per file
 * is the kind of quiet narrowing this helper is for.
 */
export function scanSourceMatches(
  root: string,
  pattern: RegExp,
  options: {
    fileFloor: number;
    matchFloor: number;
    extensions?: readonly string[];
    include?: (rel: string) => boolean;
    stripComments?: boolean;
  },
): SourceMatch[] {
  if (!pattern.global) {
    throw new Error(`scanSourceMatches: pattern ${pattern} needs the g flag.`);
  }
  const files = walkSourceFiles(root, {
    floor: options.fileFloor,
    extensions: options.extensions,
  }).filter(options.include ?? (() => true));
  requireFloor(`scanSourceMatches(${root}) files`, files, options.fileFloor);

  const matches: SourceMatch[] = [];
  for (const file of files) {
    const raw = readSourceText(join(root, file));
    const source = options.stripComments ? stripComments(raw) : raw;
    for (const m of source.matchAll(pattern)) {
      const line = source.slice(0, m.index).split("\n").length;
      matches.push({ file, line, text: m[0] });
    }
  }
  return requireFloor(
    `scanSourceMatches(${root}, ${pattern})`,
    matches,
    options.matchFloor,
  ) as SourceMatch[];
}

/** Something a file must still contain for a read of it to mean anything. */
export type SourceAnchor = string | RegExp;

function anchorCount(text: string, anchor: SourceAnchor): number {
  if (typeof anchor === "string") return text.split(anchor).length - 1;
  const flags = anchor.flags.includes("g") ? anchor.flags : `${anchor.flags}g`;
  return [...text.matchAll(new RegExp(anchor.source, flags))].length;
}

/**
 * Read one source file by path, and prove it is still the file the guard is
 * about.
 *
 * A guard that reads a fixed path and asserts that something is ABSENT
 * (`expect(source).not.toMatch(…)`) is green on a file that has been split:
 * the code it watched moved next door, the old path holds whatever is left,
 * and the absence is true for the wrong reason. A missing file at least
 * throws; a file that kept its name but lost its contents does not.
 *
 * So the caller names at least one anchor: a string or pattern the watched
 * code itself carries (the function the guard is about, the call it pins).
 * Every anchor must match at least once, or this throws and names the file,
 * which is the moment to point the guard at the new home (or at a folder
 * with `readSourceFolder`). `rel` is relative to the repository root.
 */
export function readSource(
  rel: string,
  anchors: SourceAnchor | readonly SourceAnchor[],
): string {
  const list = (Array.isArray(anchors) ? anchors : [anchors]) as SourceAnchor[];
  if (list.length === 0) {
    throw new Error(
      `readSource(${rel}): name at least one anchor the watched code carries.`,
    );
  }
  const path = join(process.cwd(), rel);
  if (!existsSync(path)) {
    throw new Error(
      `readSource(${rel}): the file does not exist. If it was split or moved, ` +
        `point the guard at the new location or scan the folder with ` +
        `readSourceFolder and a floor.`,
    );
  }
  const text = readSourceText(path);
  const lost = list.filter((anchor) => anchorCount(text, anchor) === 0);
  if (lost.length > 0) {
    throw new Error(
      `readSource(${rel}): the file no longer contains ${lost
        .map(String)
        .join(", ")}. The code this guard watches has moved; a negative ` +
        `assertion on this file would now pass for the wrong reason.`,
    );
  }
  return text;
}

/**
 * Read every source file under a folder (relative to the repository root),
 * with a floor on how many it found: the folder-scan form of `readSource`
 * for a guard whose subject was split into several files. Returns
 * `[path relative to the folder, text]` pairs, sorted.
 */
export function readSourceFolder(
  relDir: string,
  options: {
    floor: number;
    include?: (rel: string) => boolean;
    extensions?: readonly string[];
  },
): Array<[string, string]> {
  const root = join(process.cwd(), relDir);
  const files = walkSourceFiles(root, {
    floor: options.floor,
    extensions: options.extensions,
  }).filter(options.include ?? (() => true));
  requireFloor(`readSourceFolder(${relDir})`, files, options.floor);
  return files.map((rel) => [rel, readSourceText(join(root, rel))]);
}

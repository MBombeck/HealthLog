/**
 * Every web action behind a fresh-proof gate goes through the re-proof dialog.
 *
 * Two server gates hold an action back until the session has proved something
 * recently: the recent-proof gate (`requireRecentProof`,
 * `assertRecentCookieProof`, 401 `auth.reproof.required`) and the fresh-factor
 * gate (`requireFreshMfa` and the helpers that escalate to it, 401
 * `auth.stepup.required`). Both name the proofs that clear them in
 * `meta.methods`, and `useRecentProof` opens the dialog on either, posts the
 * proof to `/api/auth/reproof` and runs the action once more.
 *
 * The defect this exists for: the managed-profile acts (handing a profile
 * over, adding and removing a Guardian, creating, editing and ending a
 * record) answered the fresh-factor refusal with a sentence telling the
 * person to confirm their second factor, and offered nowhere to do it. The
 * same was true of disabling the second factor, rotating recovery codes,
 * removing a security key or passkey, changing the password, the data wipe,
 * account deletion and the key rotation. The recent-proof surfaces had the
 * dialog; the fresh-factor ones had text.
 *
 * What it pins:
 *
 *   1. The set of gated route methods, discovered from the route files and
 *      frozen below. A new gated route has to be entered here, with either
 *      its web callers checked by the sweep or the reason it has none.
 *   2. Every request a web file makes to one of them runs inside the shared
 *      flow: `recentProof.run(…)` in a component, or `guard(…)` inside a
 *      query hook whose `guard` parameter every caller fills with
 *      `recentProof.run`. A gated request outside it is the defect again.
 *
 * Every sweep asserts a floor, because a matcher that finds nothing agrees
 * with every list.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

function read(rel: string): string {
  return readSourceText(join(SRC, rel));
}

/**
 * Source with comments removed, so a route that only DESCRIBES a gate in its
 * doc comment is not counted, and a path quoted in a comment is not a call.
 */
const codeCache = new Map<string, string>();

function code(rel: string): string {
  let stripped = codeCache.get(rel);
  if (stripped === undefined) {
    stripped = stripComments(read(rel), rel);
    codeCache.set(rel, stripped);
  }
  return stripped;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const GATE =
  /\b(?:requireFreshMfa|requireFreshMfaIfEnrolled|requireFreshMfaOrElevationIfEnrolled|requireRecentProof|assertRecentCookieProof)\s*\(|\bfreshFactor\s*:\s*true\b/;

/** `src/app/api/a/[id]/route.ts` -> `/api/a/[id]`. */
function routePath(rel: string): string {
  return "/" + rel.replace(/^app\//, "").replace(/\/route\.ts$/, "");
}

/** The gated `METHOD /api/path` pairs, read off the route files. */
function discoverGatedRoutes(): string[] {
  const routes = walkSourceFiles(join(SRC, "app", "api"), { floor: 300 })
    .filter((p) => p.endsWith("/route.ts") && !p.includes("__tests__"))
    .map((p) => `app/api/${p}`);
  expect(routes.length).toBeGreaterThan(300);

  const found = new Set<string>();
  for (const rel of routes) {
    const src = code(rel);
    if (!GATE.test(src)) continue;
    const exportRe = new RegExp(
      `export\\s+(?:const\\s+(${METHODS.join("|")})\\s*=|async\\s+function\\s+(${METHODS.join("|")})\\s*\\()`,
      "g",
    );
    const exports = [...src.matchAll(exportRe)].map((m) => ({
      method: m[1] ?? m[2],
      index: m.index ?? 0,
    }));
    const path = routePath(rel);
    // A gate before the first exported method lives in a helper or a
    // `handler` constant the exports wrap, and binds every method.
    const preamble = src.slice(0, exports[0]?.index ?? src.length);
    if (GATE.test(preamble)) {
      for (const e of exports) found.add(`${e.method} ${path}`);
    }
    exports.forEach((e, i) => {
      const block = src.slice(e.index, exports[i + 1]?.index ?? src.length);
      if (GATE.test(block)) found.add(`${e.method} ${path}`);
    });
  }
  return [...found].sort();
}

/**
 * Every gated route method, and how the web reaches it. `"web"` means the
 * sweep below finds its callers and checks them; anything else is the reason
 * no web file calls it.
 */
const GATED_ROUTES: Record<string, string> = {
  "DELETE /api/admin/data": "web",
  "DELETE /api/admin/users/[id]": "web",
  "DELETE /api/auth/me/mfa/webauthn/[id]": "web",
  "DELETE /api/auth/passkeys/[id]": "web",
  "DELETE /api/managed-profiles/[id]": "web",
  "DELETE /api/managed-profiles/[id]/guardians/[grantId]": "web",
  "DELETE /api/settings/account": "web",
  "DELETE /api/settings/data": "web",
  "GET /api/admin/backups/[id]/download": "web",
  "GET /api/auth/reproof":
    "the flow's own question: the web asks it inside recentProof.run before an upload or a typed confirmation",
  "GET /api/export":
    "the plaintext whole-record download (`type=all`); the web's whole-record export is the full backup, and its single-type exports have their own routes",
  "GET /api/export/full-backup": "web",
  "GET /api/fhir/Patient/$everything":
    "a FHIR client endpoint, reached with a fhir:read token; no web file calls it",
  "GET /api/mcp/oauth/authorize":
    "a browser navigation from an assistant, answered with a page that links to /confirm-access, which runs the dialog",
  "PATCH /api/managed-profiles/[id]": "web",
  "POST /api/account/grants": "web",
  "POST /api/admin/backups/[id]/restore": "web",
  "POST /api/admin/backups/upload": "web",
  "POST /api/admin/encryption/rotate": "web",
  "POST /api/admin/users/[id]/reset-password": "web",
  "POST /api/auth/me/mfa/disable": "web",
  "POST /api/auth/me/mfa/recovery-codes/regenerate": "web",
  "POST /api/auth/password": "web",
  "POST /api/export/encrypted": "web",
  "POST /api/export/health-record": "web",
  "POST /api/managed-profiles": "web",
  "POST /api/managed-profiles/[id]/guardians": "web",
  "POST /api/managed-profiles/[id]/handover": "web",
  "POST /api/mcp/oauth/authorize":
    "the consent form's own submission, refused into the same /confirm-access page as the GET",
  "POST /api/mcp/tokens": "web",
  "POST /api/share-links": "web",
  "POST /api/tokens/documents": "web",
  "POST /api/tokens/measurements": "web",
  "POST /api/tokens/workouts": "web",
};

/** The web side: everything under src that is not a route, a test or docs. */
function webFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.startsWith("app/api/"))
    .filter((p) => !p.startsWith("lib/openapi/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

/** A string or template literal naming exactly this path. */
function pathPattern(path: string): RegExp {
  const body = path
    .split("/")
    .map((seg) =>
      /^\[.+\]$/.test(seg)
        ? "\\$\\{[^}]+\\}"
        : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  return new RegExp(`["'\`]${body}(?=["'\`?])`, "g");
}

/** Which method a call naming the path at `index` sends. */
function methodAt(src: string, index: number, matchLength: number): string {
  const before = src.slice(Math.max(0, index - 160), index);
  const helper = [
    ...before.matchAll(/\bapi(Get|Post|Put|Patch|Delete)\b(?:<[^()]*>)?\s*\(/g),
  ].pop();
  // The helper must be the call this literal is the first argument of.
  if (
    helper &&
    /^\s*$/.test(before.slice((helper.index ?? 0) + helper[0].length))
  ) {
    return helper[1].toUpperCase();
  }
  const after = src.slice(index + matchLength, index + matchLength + 240);
  const explicit = after.match(/method\s*:\s*["'](\w+)["']/);
  return explicit ? explicit[1].toUpperCase() : "GET";
}

/** The name of the function the code at `index` sits in, if it has one. */
function enclosingFunction(src: string, index: number): string | null {
  const head = src.slice(0, index);
  const decls = [
    ...head.matchAll(
      /(?:\bfunction\s+(\w+)\s*\(|\b(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>)/g,
    ),
  ].pop();
  return decls ? (decls[1] ?? decls[2] ?? null) : null;
}

/**
 * The request at `index` runs inside the shared flow: directly inside a
 * `recentProof.run(…)` or a hook's `guard(…)`, or in a named function that is
 * itself handed to, or called from, `recentProof.run`.
 */
function guardedAt(src: string, index: number): boolean {
  const before = src.slice(Math.max(0, index - 400), index);
  if (/(?:\.run|\bguard)\s*\(/.test(before)) return true;
  const name = enclosingFunction(src, index);
  if (!name) return false;
  return new RegExp(
    `\\.run\\(\\s*(?:async\\s*)?(?:\\(\\)\\s*=>\\s*)?${name}\\b`,
  ).test(src);
}

interface GatedCall {
  file: string;
  route: string;
  guarded: boolean;
}

/**
 * A query hook whose request is not guarded inside the hook is still guarded
 * when every component that mounts it sends the mutation through the flow:
 * `recentProof.run(() => mutation.mutateAsync(…))`. At least one such
 * component must exist, or nothing is guarded.
 */
function hookCallersWrap(
  files: string[],
  hookFile: string,
  src: string,
  index: number,
): boolean {
  const hook = [
    ...src.slice(0, index).matchAll(/export function (use\w+)/g),
  ].pop()?.[1];
  if (!hook) return false;
  let callers = 0;
  for (const file of files) {
    if (file === hookFile) continue;
    const other = code(file);
    for (const m of other.matchAll(
      new RegExp(`\\b(?:const|let)\\s+(\\w+)\\s*=\\s*${hook}\\s*\\(`, "g"),
    )) {
      callers++;
      const wraps = new RegExp(
        `\\.run\\(\\s*(?:async\\s*)?\\(\\)\\s*=>\\s*${m[1]}\\.mutateAsync\\b`,
      );
      if (!wraps.test(other)) return false;
    }
  }
  return callers > 0;
}

let gatedCalls: GatedCall[] | null = null;

/** Every web call of a gated route, found once per run. */
function gatedWebCalls(): GatedCall[] {
  gatedCalls ??= findGatedWebCalls();
  return gatedCalls;
}

function findGatedWebCalls(): GatedCall[] {
  const calls: GatedCall[] = [];
  const files = webFiles();
  const sources = new Map(files.map((f) => [f, code(f)]));
  for (const route of Object.keys(GATED_ROUTES)) {
    if (GATED_ROUTES[route] !== "web") continue;
    const [method, path] = route.split(" ");
    const re = pathPattern(path);
    // Every match spells the path's static head out literally, up to the
    // first `[param]`; a file without it cannot match and is not searched.
    const head = path.split("/[")[0];
    for (const file of files) {
      const src = sources.get(file) ?? "";
      if (!src.includes(head)) continue;
      for (const m of src.matchAll(re)) {
        const index = m.index ?? 0;
        // The path handed to a component as a prop (`endpoint="/api/…"`):
        // the request is wherever that component sends the prop.
        const prop = src.slice(Math.max(0, index - 40), index).match(/(\w+)=$/);
        if (prop) {
          const sends = [
            ...src.matchAll(
              new RegExp(`\\bapiFetchRaw\\(\\s*${prop[1]}\\s*,`, "g"),
            ),
          ];
          for (const send of sends) {
            const at = send.index ?? 0;
            if (methodAt(src, at, send[0].length) !== method) continue;
            calls.push({ file, route, guarded: guardedAt(src, at) });
          }
          continue;
        }
        if (methodAt(src, index, m[0].length) !== method) continue;
        const guarded =
          guardedAt(src, index) ||
          (file.startsWith("lib/queries/") &&
            hookCallersWrap(files, file, src, index));
        calls.push({ file, route, guarded });
      }
    }
  }
  return calls;
}

/**
 * Calls the sweep cannot read as guarded, each checked by hand and pinned.
 * The request runs after a `recentProof.run(() => apiGet("/api/auth/reproof"))`
 * a few lines earlier, so the proof is in place before a file is sent or a
 * typed confirmation is spent.
 */
const PRECHECKED = new Set<string>([
  // `upload.mutationFn` asks first, then calls `uploadOnce`, so a large file
  // is not sent once only to be refused.
  "components/admin/backups/use-backup-upload.ts -> POST /api/admin/backups/upload",
]);

describe("fresh-proof gates on the web", () => {
  it("freezes the set of gated route methods", () => {
    const discovered = discoverGatedRoutes();
    expect(discovered.length).toBeGreaterThanOrEqual(30);
    expect(discovered).toEqual(Object.keys(GATED_ROUTES).sort());
  });

  it("finds a web caller for every route marked as called from the web", () => {
    const calls = gatedWebCalls();
    expect(calls.length).toBeGreaterThanOrEqual(25);
    const reached = new Set(calls.map((c) => c.route));
    const unreached = Object.keys(GATED_ROUTES).filter(
      (r) => GATED_ROUTES[r] === "web" && !reached.has(r),
    );
    expect(unreached).toEqual([]);
  });

  it("sends every gated request through the re-proof flow", () => {
    const unguarded = gatedWebCalls()
      .filter((c) => !c.guarded)
      .map((c) => `${c.file} -> ${c.route}`)
      .filter((key) => !PRECHECKED.has(key));
    expect(unguarded).toEqual([]);
  });

  it("renders the dialog wherever a component runs the flow", () => {
    const files = [...new Set(gatedWebCalls().map((c) => c.file))].filter((f) =>
      f.endsWith(".tsx"),
    );
    expect(files.length).toBeGreaterThanOrEqual(10);
    const missing = files.filter((f) => {
      const src = code(f);
      return !/useRecentProof\s*\(/.test(src) || !/\.dialog\b/.test(src);
    });
    expect(missing).toEqual([]);
  });

  it("makes every caller of a guarded query hook pass recentProof.run", () => {
    // Hooks whose gated request runs inside `guard(…)`.
    const hookFiles = [
      ...new Set(
        gatedWebCalls()
          .filter((c) => c.file.startsWith("lib/queries/"))
          .map((c) => c.file),
      ),
    ];
    expect(hookFiles.length).toBeGreaterThanOrEqual(1);
    const hooks: string[] = [];
    for (const file of hookFiles) {
      for (const m of code(file).matchAll(
        /export function (use\w+)\(\s*guard\s*:\s*ProofGuard\s*\)/g,
      )) {
        hooks.push(m[1]);
      }
    }
    expect(hooks.length).toBeGreaterThanOrEqual(6);

    const offenders: string[] = [];
    let callSites = 0;
    for (const file of webFiles()) {
      if (hookFiles.includes(file)) continue;
      const src = code(file);
      for (const hook of hooks) {
        for (const m of src.matchAll(
          new RegExp(`\\b${hook}\\s*\\(([^)]*)\\)`, "g"),
        )) {
          callSites++;
          if (!/^\s*\w+\.run\s*$/.test(m[1])) {
            offenders.push(`${file}: ${hook}(${m[1].trim()})`);
          }
        }
      }
    }
    expect(callSites).toBeGreaterThanOrEqual(6);
    expect(offenders).toEqual([]);
  });
});

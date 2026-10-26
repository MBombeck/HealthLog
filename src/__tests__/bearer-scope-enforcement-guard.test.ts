/**
 * Structural guards on the Bearer-scope enforcement boundary.
 *
 * The correctness argument for the fail-closed default is structural, not
 * empirical: there is exactly ONE place a raw Bearer token becomes a user, and
 * exactly ONE authorisation arm inside it. Seven behavioural tests cannot cover
 * 300-odd routes; what they can do is rest on that invariant. These guards are
 * what keep the invariant true.
 *
 * They are tripwires, not proofs. They cannot show an allowlist is correct —
 * only that it has not changed without someone editing this file. A reviewer
 * who waves through a bad addition defeats all four, and no test substitutes
 * for that review.
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";

import { guardSourceOf } from "./helpers/auth-guards";
import {
  readSource,
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/**
 * Every non-test `.ts` / `.tsx` under `src/`, excluding the generated Prisma
 * client (9 MB; never read it) and test files themselves.
 */
function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

function read(rel: string): string {
  return readSourceText(join(SRC, rel));
}

function filesMatching(re: RegExp): string[] {
  return sourceFiles().filter((rel) => re.test(read(rel)));
}

/**
 * The argument text of every call to `callee` in `src`, parens balanced.
 *
 * The matchers this file used to rely on stopped at the first `)` —
 * `requireRecordAuth\([^)]*scope:` read `requireRecordAuth(need(), "x", {
 * scope: X })` as having no scope at all — and demanded one spelling of a
 * Bearer lookup. A guard whose matcher misses a real call site is green
 * because it matched nothing. So calls are read whole: from the `(` after the
 * name to its matching `)`, skipping string and template contents, and a
 * function DECLARATION of the same name is not a call.
 */
function callArgs(src: string, callee: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  const re = new RegExp(`(?<![\\w$.])${callee}\\s*\\(`, "g");
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (/function\s*$/.test(code.slice(Math.max(0, m.index - 12), m.index))) {
      continue;
    }
    out.push(argsFrom(code, m.index + m[0].length - 1));
  }
  return out;
}

/** The text between the `(` at `open` and its matching `)`. */
function argsFrom(code: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  let i = open;
  for (; i < code.length; i++) {
    const ch = code[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) break;
    }
  }
  return code.slice(open + 1, i);
}

/** Split an argument list at its top-level commas. */
function topLevelArgs(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = args.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

/** The scope a `requireAuth` call names: its first argument, or null. */
function requireAuthScopes(src: string): Array<string | null> {
  return callArgs(src, "requireAuth").map((args) => {
    const first = topLevelArgs(args)[0];
    return first === undefined || first === "undefined" ? null : first;
  });
}

/** The scopes the `requireRecordAuth` calls in `src` name in their options. */
function recordAuthScopes(src: string): string[] {
  const out: string[] = [];
  for (const args of callArgs(src, "requireRecordAuth")) {
    for (const m of args.matchAll(/\bscope\s*:\s*([A-Za-z_$][\w$]*)/g)) {
      out.push(m[1]);
    }
  }
  return out;
}

/**
 * Whether `src` turns a Bearer value into an identity: the shared resolver, or
 * any `apiToken` lookup (`findUnique`, `findFirst`, `findMany`, their
 * `OrThrow` forms, on `prisma` or a transaction) whose arguments name
 * `tokenHash`, or raw SQL reading `api_tokens` by `token_hash`.
 */
function resolvesBearer(src: string): boolean {
  const code = stripComments(src);
  // The shared resolver, and the MCP edge's wrapper around it. The `/mcp`
  // route was on the allowlist only because a COMMENT named the resolver;
  // with comments stripped it is found by the call it actually makes.
  if (/\bresolveBearerToken\b|\bresolveMcpAuthContext\s*\(/.test(code)) {
    return true;
  }
  const lookups =
    /\bapiToken\s*\.\s*find(?:Unique|First|Many)(?:OrThrow)?\s*\(/g;
  for (const m of code.matchAll(lookups)) {
    const args = argsFrom(code, m.index + m[0].length - 1);
    if (/\btokenHash\b/.test(args)) return true;
  }
  // A raw read of the table by hash. An UPDATE that revokes by hash turns
  // nothing into an identity and is not one.
  return /\bSELECT\b[\s\S]{0,300}?\bFROM\s+"?api_tokens"?[\s\S]{0,300}?\btoken_hash\b/i.test(
    code,
  );
}

describe("the call matchers read whole calls", () => {
  it("finds a scope behind nested parentheses and across lines", () => {
    const planted = `const ctx = await requireRecordAuth(
      needFor(method()),
      "measurements",
      { scope: MEASUREMENTS_WRITE_SCOPE },
    );`;
    expect(recordAuthScopes(planted)).toEqual(["MEASUREMENTS_WRITE_SCOPE"]);
    // The old matcher stopped at the first ")" and saw nothing.
    expect(/requireRecordAuth\([^)]*\bscope:/.test(planted)).toBe(false);
  });

  it("reads the first requireAuth argument and ignores the options", () => {
    expect(
      requireAuthScopes(
        'await requireAuth(WORKOUTS_WRITE_SCOPE, { writeBucket: "own" });\n' +
          'await requireAuth(undefined, { writeBucket: "own" });\n' +
          "await requireAuth();\n" +
          "export async function requireAuth(requiredPermission?: string) {}\n" +
          'await requireAuth("health:write");',
      ),
    ).toEqual(["WORKOUTS_WRITE_SCOPE", null, null, '"health:write"']);
  });

  it("recognises every spelling of a Bearer lookup", () => {
    for (const planted of [
      "prisma.apiToken.findUnique({ where: { tokenHash: h } })",
      "prisma.apiToken\n  .findUnique({\n    where: { userId, tokenHash: hash },\n  })",
      "tx.apiToken.findFirst({ where: { revokedAt: null, tokenHash: digest(x) } })",
      "await prisma.apiToken.findUniqueOrThrow({ where: { tokenHash } })",
      "prisma.$queryRaw`SELECT user_id FROM api_tokens WHERE token_hash = ${h}`",
    ]) {
      expect(resolvesBearer(planted), planted).toBe(true);
    }
    // A lookup by something else is not a Bearer resolution, even with the
    // word elsewhere in the file, and neither is a revocation by hash.
    expect(
      resolvesBearer(
        "prisma.apiToken.findMany({ where: { userId } });\nconst tokenHash = 1;",
      ),
    ).toBe(false);
    expect(
      resolvesBearer(
        "prisma.$executeRaw`UPDATE api_tokens SET revoked = true WHERE token_hash = ${h}`",
      ),
    ).toBe(false);
  });
});

describe("T1 — the Bearer resolution set is frozen", () => {
  /**
   * Files allowed to turn a raw `Authorization: Bearer` value into a user.
   * This is the set that can circumvent the enforcement point, so it is the
   * only set that matters for the fail-closed guarantee.
   *
   * Two of these authenticate a request; the rest are the resolver itself and
   * the two edges that wrap it.
   */
  const RESOLUTION_ALLOWLIST = [
    // The resolver. Owns the one authorisation arm.
    "lib/auth/bearer.ts",
    // The REST edge — maps `requireAuth`'s optional scope onto the union. The
    // guard module behind `requireAuth`, re-exported by `lib/api-handler.ts`.
    "lib/auth/guards/caller.ts",
    // The MCP edge — the one deliberate `any-valid-token` posture.
    "lib/mcp/auth.ts",
    // The `/mcp` transport, via `resolveMcpAuthContext`.
    "app/mcp/route.ts",
    // The local stdio MCP entrypoint, via the same `resolveMcpAuthContext`: a
    // pasted token for a power-user's own MCP client, run in a plain Node
    // process outside the web server. Same edge, same posture as `/mcp`. It
    // was a Bearer resolution this guard never saw, because the matcher only
    // knew the resolver's own name and the `/mcp` entry above was matched
    // through a comment.
    "cli/mcp-stdio.ts",
    // Hand-rolled Bearer authentication: the external medication-ingest
    // surface, which gates on BOTH `medication:ingest` and the per-medication
    // `medication:<id>:ingest` grant and never touches `requireAuth`.
    "app/api/ingest/medication/route.ts",
    // `defaultUserIdResolver` — resolves the Bearer token to a user id so an
    // idempotency key files under its owner. It authorises nothing: the
    // handler still runs its own `requireAuth()`, and this resolver only
    // decides which cache cell a replay lands in. Since delegated writes it
    // decides that from two values — the caller resolved here, and the record
    // the request claims, read through the one acting-account carrier reader
    // and folded into the key. Both are unchecked selectors; neither widens
    // what the handler will do. Narrow in reach and deliberate, but it is a
    // raw Bearer value becoming a user id, so it belongs on this list rather
    // than beside it.
    "lib/idempotency.ts",
  ].sort();

  it("no file outside the allowlist resolves a Bearer token to a user", () => {
    // `resolveBearerToken` is the shared primitive; a `tokenHash` lookup is the
    // hand-rolled equivalent. Either one turns a bearer credential into an
    // identity, so both have to stay inside the allowlist.
    //
    // The whitespace classes around `.findUnique` are load-bearing. The
    // original matcher demanded the literal `apiToken.findUnique(`, and
    // `lib/idempotency.ts` writes the call fluent-style — `prisma.apiToken`,
    // newline, `.findUnique({`. It resolved a Bearer token to a user id for
    // three releases without this guard ever seeing it. A matcher that misses
    // a real resolver is green because it matched nothing, not because
    // nothing was there.
    // `tokenHash` may sit anywhere inside the `where` object — demanding it
    // first would let a formatting change (another key ahead of it) walk a
    // resolver out of the guard's sight.
    const resolvers = sourceFiles().filter((rel) => resolvesBearer(read(rel)));

    // Non-zero proof: an empty match set must fail rather than agree with an
    // emptied allowlist.
    expect(resolvers.length).toBeGreaterThan(0);
    expect(resolvers).toEqual(RESOLUTION_ALLOWLIST);
  });

  it("the resolver exposes exactly one authorisation arm", () => {
    const src = readSource(
      "src/lib/auth/bearer.ts",
      'permissions.includes("*")',
    );
    // One wildcard escape hatch, guarding one deny block. If a second
    // `permissions.includes("*")` short-circuit appears, the arm has forked.
    const wildcardChecks = src.match(/permissions\.includes\("\*"\)/g) ?? [];
    expect(wildcardChecks).toHaveLength(1);
  });
});

describe("T2 — `any-valid-token` is the single deliberate fail-open posture", () => {
  it("appears at exactly one call site, and that call site is the MCP edge", () => {
    // `bearer.ts` necessarily names the variant to declare the union; what
    // must stay unique is a caller PASSING it.
    const optedOut = filesMatching(/kind:\s*"any-valid-token"/).filter(
      (rel) => rel !== "lib/auth/bearer.ts",
    );
    expect(optedOut).toEqual(["lib/mcp/auth.ts"]);
  });

  it("no route file opts out of the fail-closed default", () => {
    const routes = sourceFiles().filter((p) => p.endsWith("/route.ts"));
    const optedOut = routes.filter((rel) =>
      /kind:\s*"any-valid-token"/.test(read(rel)),
    );
    expect(optedOut).toEqual([]);
  });
});

describe("T3 — the mint sites are frozen", () => {
  /**
   * Every place an `ApiToken` row is created, with the scope set it may mint.
   * A new mint site, or a new scope on an existing one, has to be named here —
   * which is the point: a user-facing mint that hands out a broad scope is the
   * one failure mode the enforcement change cannot catch by itself.
   */
  const MINT_SITES: Record<string, string> = {
    // Cookie-equivalent. The ONLY `["*"]` mints, all behind a completed login.
    "lib/auth/issue-token.ts": 'opts.permissions ?? ["*"]',
    "lib/auth/login-response.ts": '["*"]',
    "lib/auth/refresh-token.ts": '["*"]',
    "app/api/auth/passkey/login-verify/route.ts": '["*"]',
    // The working medication-ingest pair — family marker plus the per-
    // medication grant that `/api/ingest/medication` actually gates on.
    "app/api/medications/[id]/api-endpoint/route.ts":
      '["medication:ingest", scope]',
    // Third-party measurement ingest. One shape, built from a literal — the
    // body cannot express a scope. Reaches two write routes on the holder's
    // own record and nothing else, the mint included.
    "app/api/tokens/measurements/route.ts": "[MEASUREMENTS_WRITE_SCOPE]",
    // Document upload from another system (#1038). Same shape as the
    // measurement mint: a literal, one scope, one route that accepts it.
    "app/api/tokens/documents/route.ts": "[DOCUMENTS_WRITE_SCOPE]",
    // Workout ingest from a bridge (#1054). Same shape again: a literal, one
    // scope, one route that accepts it.
    "app/api/tokens/workouts/route.ts": "[WORKOUTS_WRITE_SCOPE]",
    // MCP, audience-bound to `/mcp`. `health:write` requires explicit consent.
    "app/api/mcp/tokens/route.ts": "SCOPE_HEALTH_READ / SCOPE_HEALTH_WRITE",
    "app/api/mcp/oauth/token/route.ts":
      "SCOPE_HEALTH_READ / SCOPE_HEALTH_WRITE",
  };

  it("only the known files create ApiToken rows", () => {
    // Whitespace-tolerant like the T1 resolver matcher — the lesson this
    // very file documents: a prettier-wrapped `apiToken\n  .create({` was
    // invisible to the literal matcher, and a guard that matches nothing
    // is green for the wrong reason.
    const minters = filesMatching(
      /apiToken\s*\.\s*create\s*\(|issueApiToken\s*\(/,
    );
    // Non-zero proof: an empty match set must fail rather than agree with
    // an emptied site table.
    expect(minters.length).toBeGreaterThan(0);
    expect(minters).toEqual(Object.keys(MINT_SITES).sort());
  });

  it("no user-facing mint hands out a wildcard scope", () => {
    // The four `["*"]` mints are all reached only by a completed
    // password / passkey / refresh exchange. Every other mint is narrow.
    const userFacing = [
      "app/api/medications/[id]/api-endpoint/route.ts",
      "app/api/tokens/measurements/route.ts",
      "app/api/tokens/documents/route.ts",
      "app/api/tokens/workouts/route.ts",
      "app/api/mcp/tokens/route.ts",
      "app/api/mcp/oauth/token/route.ts",
    ];
    for (const rel of userFacing) {
      expect(read(rel)).not.toMatch(/permissions:\s*\[\s*"\*"/);
    }
  });

  it("the retired generic token mint is gone", () => {
    // `POST /api/tokens` minted `["medication:ingest"]` — a token that could
    // not perform its advertised job (it lacked the per-medication grant) and
    // could reach every other authenticated route. List and revoke stay.
    //
    // The sibling `app/api/tokens/measurements/route.ts` does export a POST and
    // does not contradict this: what was retired is a mint at THIS path that
    // named no scope and answered for the whole API. A child path minting one
    // named scope, listed in `MINT_SITES` above, is the shape that replaced it.
    const tokensRoute = readSource(
      "src/app/api/tokens/route.ts",
      "export const GET",
    );
    expect(tokensRoute).not.toMatch(/export const POST/);
    expect(tokensRoute).toMatch(/export const GET/);
  });
});

describe("T4 — declared scopes are exported constants, never string literals", () => {
  it("every requireAuth scope argument is an identifier", () => {
    const offenders: string[] = [];
    for (const rel of sourceFiles()) {
      for (const scope of requireAuthScopes(read(rel))) {
        if (scope !== null && !/^[A-Za-z_$][\w$]*$/.test(scope)) {
          offenders.push(`${rel}: requireAuth(${scope})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the declared scope vocabulary is closed", () => {
    // Scopes a route may name. Adding one means adding a route that accepts a
    // narrow token, which is a widening — it belongs in a reviewed diff.
    //
    // Both ways of naming one are collected, and that is the point of the
    // second matcher rather than a tidiness: since `requireRecordAuth` grew a
    // `scope` option, a route can widen itself without the word `requireAuth`
    // appearing anywhere in it. A vocabulary that watched only the first form
    // would have gone on passing while the surface it describes grew.
    const DECLARED_SCOPES = [
      "DOCUMENTS_WRITE_SCOPE",
      "FHIR_READ_SCOPE",
      "MEASUREMENTS_WRITE_SCOPE",
      "WORKOUTS_WRITE_SCOPE",
    ];
    const used = new Set<string>();
    for (const rel of sourceFiles()) {
      const src = read(rel);
      for (const scope of requireAuthScopes(src)) {
        if (scope !== null) used.add(scope);
      }
      for (const scope of recordAuthScopes(src)) used.add(scope);
    }
    expect([...used].sort()).toEqual(DECLARED_SCOPES);
  });
});

describe("T4b — `documents:write` opens exactly two doors", () => {
  it("only the vault upload and the source-key lookup declare the scope", () => {
    // The scope admits a narrow token wherever it is named, so the set of
    // files naming it IS its reach. The upload, and the lookup that answers
    // what an upload of the same key would answer (known / id / deleted) so
    // an importer can skip a download. Nothing else: not the list or detail,
    // not the original or thumbnail, not bulk, not the AI legs. A third route
    // here is a widening and belongs in review.
    const declaring = sourceFiles().filter((rel) => {
      const src = read(rel);
      return (
        requireAuthScopes(src).includes("DOCUMENTS_WRITE_SCOPE") ||
        recordAuthScopes(src).includes("DOCUMENTS_WRITE_SCOPE")
      );
    });
    expect(declaring).toEqual([
      "app/api/documents/inbound/route.ts",
      "app/api/documents/inbound/source/route.ts",
    ]);
    // Within the upload file, once: the GET list beside the POST must not
    // name it.
    const upload = readSource(
      "src/app/api/documents/inbound/route.ts",
      "DOCUMENTS_WRITE_SCOPE",
    );
    expect(
      requireAuthScopes(upload).filter((x) => x === "DOCUMENTS_WRITE_SCOPE"),
    ).toHaveLength(1);
    // And the lookup is a read of one key and nothing else: a single GET.
    const lookup = readSource(
      "src/app/api/documents/inbound/source/route.ts",
      "export const GET",
    );
    expect(
      [...lookup.matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\b/g)].map(
        (m) => m[1],
      ),
    ).toEqual(["GET"]);
  });
});

describe("T4c — `workouts:write` opens exactly one door", () => {
  it("only the workout batch declares the scope, and only on its POST", () => {
    // The set of files naming the scope IS its reach. The batch ingest and
    // nothing else: not the workout list or detail, which would hand a
    // bridge the history it has no business reading back.
    const declaring = sourceFiles().filter((rel) => {
      const src = read(rel);
      return (
        requireAuthScopes(src).includes("WORKOUTS_WRITE_SCOPE") ||
        recordAuthScopes(src).includes("WORKOUTS_WRITE_SCOPE")
      );
    });
    expect(declaring).toEqual(["app/api/workouts/batch/route.ts"]);
    const batch = readSource(
      "src/app/api/workouts/batch/route.ts",
      "WORKOUTS_WRITE_SCOPE",
    );
    expect(
      requireAuthScopes(batch).filter((x) => x === "WORKOUTS_WRITE_SCOPE"),
    ).toHaveLength(1);
    expect(
      [...batch.matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\b/g)].map(
        (m) => m[1],
      ),
    ).toEqual(["POST"]);
  });
});

describe("T5 — a delegable route naming a Bearer scope is frozen", () => {
  /**
   * Routes that admit a narrow token on a DELEGABLE surface, and the scope each
   * one names.
   *
   * Two declarations meet on these routes and neither implies the other: the
   * route may act on somebody else's record, AND it accepts a credential minted
   * for one job. `requireRecordAuth` refuses that combination at run time — a
   * scoped credential naming another record is turned away before any grant is
   * read — and this table is what keeps the SET of routes making both
   * declarations from growing quietly.
   */
  const SCOPED_RECORD_ROUTES: Record<string, string> = {
    // Third-party measurement ingest: a scale, a watch bridge, a
    // home-automation rule. The sibling read, edit and delete legs on this
    // module name no scope and so still refuse every narrow token.
    "app/api/measurements/route.ts": "MEASUREMENTS_WRITE_SCOPE",
  };

  it("only the known routes pass a scope to the record resolver", () => {
    const naming = sourceFiles().filter(
      (rel) => recordAuthScopes(read(rel)).length > 0,
    );
    // Non-zero proof: an empty match set must fail rather than agree with an
    // emptied table. This is the leg most likely to rot — the matcher spans a
    // multi-line call, so a formatting change is exactly what would silently
    // empty it.
    expect(naming.length).toBeGreaterThan(0);
    expect(naming).toEqual(Object.keys(SCOPED_RECORD_ROUTES).sort());
  });

  it("each names the scope this table says it does", () => {
    for (const [rel, scope] of Object.entries(SCOPED_RECORD_ROUTES)) {
      const named = recordAuthScopes(read(rel));
      expect(named).toEqual([scope]);
    }
  });

  it("the record resolver still refuses a scoped credential a selector", () => {
    // The whole admission rests on one `if` inside `requireRecordAuth`. Delete
    // it and every other leg in this file stays green while a single-purpose
    // token gains delegated write — so the refusal is asserted where it lives,
    // not only through the behaviour that depends on it.
    const src = guardSourceOf("requireRecordAuth", ["narrow_scope_selector"]);
    expect(src).toMatch(/narrow_scope_selector/);
    expect(src).toMatch(/isScopedCredential\(auth\)/);
  });
});

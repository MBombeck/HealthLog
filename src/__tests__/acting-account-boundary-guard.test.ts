/**
 * Structural guards on the acting-account boundary.
 *
 * The behavioural tests in `src/lib/__tests__/acting-account-resolver.test.ts`
 * prove what today's code does. These prove what tomorrow's may not do, and
 * they exist because the boundary has one shape that keeps it safe: the acting
 * account is a value ONE function is allowed to act on, and the helpers that
 * decide role and step-up never see it.
 *
 * Tripwires, not proofs. They cannot show the resolver is correct — only that
 * the boundary has not moved without somebody editing this file. Every leg
 * below asserts a non-zero match count first, because a guard whose matcher
 * finds nothing reports success, and this repository has shipped several of
 * those.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

function filesMatching(re: RegExp): string[] {
  return sourceFiles().filter((rel) => re.test(read(rel)));
}

/** The source text of a top-level exported function, braces included. */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  if (start === -1) return "";
  const open = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return "";
}

describe("the acting-account carrier is read in one place", () => {
  /**
   * Files allowed to touch `Session.actingAsUserId`.
   *
   * The column is a selector — it names an account, it does not authorise one.
   * Anything that reads it and acts on the value without going through the
   * resolver has invented a second answer to "whose record is this", and the
   * copy that drifts is always the one nobody reads.
   *
   * Later items in this feature will extend this list, and that is the point:
   * the switch endpoint (which writes it) and revocation cleanup (which clears
   * it) arrive as a visible diff here rather than as a quiet new reader.
   *
   * The matcher reads source text and does not exempt comments, so a file that
   * merely NAMES the column in prose trips it. Left that way deliberately: a
   * guard over an authorization carrier that shouts at a mention is the right
   * direction to be wrong in.
   */
  const CARRIER_ALLOWLIST = [
    // Projects it off the session row it already loaded.
    "lib/auth/session.ts",
    // Reads it. The one statement of "what does this request say it is acting
    // as", for both transports and for every caller that has to ask.
    "lib/auth/acting-carrier.ts",
    // The resolver. The only thing that acts on the value.
    "lib/api-handler.ts",
    // v1.36.0 — the only thing that WRITES it: the switch endpoint sets it
    // through here, ending a grant clears it through here. The routes
    // themselves call these two functions and never name the column, which is
    // what keeps this list from growing one entry per surface.
    "lib/sharing/acting-session.ts",
    // v1.36.0 — the only thing that PUBLISHES it, and it publishes the stamp
    // only after re-deciding it. The account payload has to say which record
    // the browser is inside so the banner can name a person, but the value it
    // prints is not the column: an entry reaches `active` solely by surviving
    // the same live-grant pass that builds the switcher list, so a stamp left
    // behind by a lapsed grant reads as "not switched" — the same answer the
    // resolver will independently give the next delegated request. Takes the
    // whole auth context for exactly this reason: had it taken the id, the
    // route would name the column too, and the list would grow per surface.
    "lib/sharing/account-access.ts",
    // v1.37.0 — the record-session fence COMPARES it and never writes it. It
    // reads the value off the `AuthContext` the resolver already holds rather
    // than from the row, which is the property the fence rests on: the scope
    // the handler serves under and the epoch the fence validated are one row
    // read, so they cannot straddle a switch. A version of this file that
    // resolved its own session would be a second answer to "whose record is
    // this" and would also be wrong more often.
    "lib/sharing/record-session-fence.ts",
    // v1.37.0 — names the column in prose only. The matcher does not exempt
    // comments and is left that way on purpose (see the note above), so the
    // module that explains the fence has to be listed. It imports nothing at
    // all, which the fence's own unit test asserts, so it can read no column
    // even in principle.
    "lib/sharing/record-session-fence-contract.ts",
  ].sort();

  it("no other file reads or writes the carrier column", () => {
    const readers = filesMatching(/actingAsUserId|acting_as_user_id/);
    // Non-zero proof: an emptied allowlist must fail rather than agree with an
    // emptied match set.
    expect(readers.length).toBeGreaterThan(0);
    expect(readers).toEqual(CARRIER_ALLOWLIST);
  });

  it("the selector header is named in one place", () => {
    // A route that read the header itself would be deciding an authorisation
    // question the resolver exists to answer once.
    //
    // The OpenAPI table is the one other file allowed to say the name, and it
    // is not a reader: it publishes the header to the clients that have to
    // send it. Listed explicitly rather than exempted by pattern, so a route
    // that starts parsing the header cannot hide behind a rule about which
    // directories are documentation.
    const namers = filesMatching(/x-healthlog-account/i);
    expect(namers.length).toBeGreaterThan(0);
    expect(namers).toEqual([
      "lib/auth/acting-carrier.ts",
      "lib/openapi/routes/account-sharing.ts",
    ]);
  });

  /**
   * Who may ask "which record does this request claim" without an auth
   * context in hand.
   *
   * `readClaimedRecordContext()` answers before any grant check has run, so a
   * caller that treats its answer as permission has skipped the only thing
   * that grants any. Exactly one caller exists, beside the file that declares
   * it: the idempotency wrapper, which uses the claim to pick a cache cell and
   * leaves the check to the handler it wraps. Everything else that needs the
   * acting account has an auth context by then and goes through
   * `requireRecordAuth`, which checks a live grant before returning. A second
   * caller here is a design question, not a patch.
   *
   * The matcher names the v1.36.0 spelling (`readClaimedActingAccount`) as well
   * as today's. That function was removed in v1.37.0 when the wrapper started
   * needing the session's record context on the same read; matching both means
   * a reintroduced narrow copy trips this leg instead of quietly becoming a
   * second answer.
   */
  it("the unchecked claim has exactly two consumers", () => {
    const consumers = filesMatching(
      /readClaimedRecordContext|readClaimedActingAccount/,
    );
    expect(consumers.length).toBeGreaterThan(0);
    expect(consumers).toEqual([
      "lib/auth/acting-carrier.ts",
      "lib/idempotency.ts",
    ]);
  });
});

describe("the cookie-only helpers cannot see the acting account", () => {
  /**
   * `requireAdmin`, `requireCookieAuth` and `requireFreshMfa` are safe under a
   * switch for one reason: they resolve through `getSession()`, which answers
   * who is CALLING, and they never consult the carrier. That is the property
   * that keeps role checks and step-up gates structurally out of a delegate's
   * reach, and it is one careless line away from being untrue.
   */
  const COOKIE_ONLY = ["requireAdmin", "requireCookieAuth", "requireFreshMfa"];

  it.each(COOKIE_ONLY)("%s resolves the actor and nothing else", (name) => {
    const body = functionBody(read("lib/api-handler.ts"), name);

    // Non-zero proof, twice over: the slice found a function, and the slice is
    // the function it claims to be. A renamed helper must fail here rather
    // than silently assert against an empty string.
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("getSession()");

    expect(body).not.toContain("actingAsUserId");
    expect(body).not.toContain("requireRecordAuth");
    expect(body).not.toContain("readActingCarrier");
  });

  it("substitutes a data-scope user in exactly two functions", () => {
    const src = read("lib/api-handler.ts");
    const record = functionBody(src, "requireRecordAuth");
    expect(record).toContain("readActingCarrier");

    // v1.37.0 — the guardian resolver is the second function that acts on the
    // carrier, and it is a second declaration rather than a level on the
    // first: it admits the surfaces of a record NOBODY runs themselves, gated
    // on the managed-profile marker rather than on the grant.
    const guardian = functionBody(src, "requireGuardianAuth");
    expect(guardian.length).toBeGreaterThan(0);
    expect(guardian).toContain("readActingCarrier");
    expect(guardian).toContain("managedProfileAt");

    // `readActingCarrier` is what turns a request into "acting as somebody
    // else". Three callers: the bare path, which refuses on it, and the two
    // record paths, which act on it. A fourth would be a mode nobody declared.
    const callers = (src.match(/await readActingCarrier\(/g) ?? []).length;
    expect(callers).toBe(3);
  });
});

describe("grant management is not delegable by construction", () => {
  /**
   * A delegate must never grant, widen, or transfer access. The way that is
   * true here is not a re-delegation check inside the handlers — a check is a
   * line somebody can move — but the mode the handlers resolve in: bare
   * `requireAuth()` refuses outright while a switch is active, so there is no
   * code path through these routes that runs as somebody else at all.
   *
   * The switch endpoint is the deliberate exception and lives elsewhere: it is
   * an actor surface because it is the way back out of a switch, and it grants
   * nothing.
   */
  const GRANT_ROUTES = [
    "app/api/account/grants/route.ts",
    "app/api/account/grants/[id]/route.ts",
    "app/api/account/grants/[id]/accept/route.ts",
    "app/api/account/grants/[id]/renounce/route.ts",
    // v1.42 (#959) — the new owner's decision about former Guardians ends and
    // writes grant rows, so it is a grant route like the four above.
    "app/api/account/handover-decision/route.ts",
  ];

  it("every grant route exists and resolves through bare requireAuth", () => {
    // Non-zero proof: a renamed or moved route must fail here rather than
    // leave the loop below with nothing to check.
    const found = sourceFiles().filter((p) => GRANT_ROUTES.includes(p));
    expect(found.sort()).toEqual([...GRANT_ROUTES].sort());

    for (const rel of GRANT_ROUTES) {
      const src = read(rel);
      expect(src, `${rel} must resolve auth`).toMatch(/await requireAuth\(\)/);
      expect(src, `${rel} must not honour a switch`).not.toContain(
        "requireRecordAuth",
      );
      expect(src, `${rel} must not declare an actor surface`).not.toContain(
        "requireActorAuth",
      );
    }
  });

  it("no grant route takes a party to the grant from the request body", () => {
    // Both ends of a grant come from the session and from the row. A body
    // field naming either would be the caller deciding an authorisation
    // question, which is the one thing no route here is allowed to do.
    for (const rel of GRANT_ROUTES) {
      const src = read(rel);
      expect(src).not.toMatch(/parsed\.data\.(grantorId|granteeId|userId)/);
    }
  });
});

describe("ending a grant and clearing the switch are one act", () => {
  /**
   * Two statements of the same fact. Split apart, a revocation that stamped
   * the row but not the sessions leaves a delegate's browser inside a record
   * it can no longer read — every request refused, the banner still naming the
   * owner, nothing on screen able to explain it.
   *
   * The behavioural half of this is
   * `tests/integration/sharing-lifecycle.test.ts`, which asserts the session
   * row after a revoke. This half holds the atomicity, which no test can
   * observe from outside.
   */
  function privateFunctionBody(src: string, name: string): string {
    const start = src.indexOf(`async function ${name}(`);
    if (start === -1) return "";
    const open = src.indexOf("{", src.indexOf(")", start));
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth -= 1;
        if (depth === 0) return src.slice(open, i + 1);
      }
    }
    return "";
  }

  it("runs the transition and the cleanup in one transaction", () => {
    const body = privateFunctionBody(
      read("lib/sharing/grants.ts"),
      "endAndClear",
    );
    // Non-zero proof: a renamed helper fails here rather than asserting
    // against an empty string, which would pass every `not.toContain` below
    // and most of what a reader assumes this test covers.
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("$transaction");
    expect(body).toContain("clearActingSessions");
  });

  it("ends a handover Guardian's row and clears their switch in the caller's transaction", () => {
    // v1.42 (#959) — the one other place a grant ends: settling a Guardian's
    // access when a managed profile is claimed or decided. It runs inside the
    // claim's own transaction (it takes `tx`), so the guard here is that the
    // cleanup is part of the same function as the ending.
    const body = functionBody(
      read("lib/sharing/grants.ts"),
      "settleHandoverGuardianGrant",
    );
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("revokedAt: input.now");
    expect(body).toContain("clearActingSessions(pair, tx)");
  });

  it("routes an ending through the cleanup, never through the bare transition", () => {
    for (const rel of [
      "app/api/account/grants/[id]/route.ts",
      "app/api/account/grants/[id]/renounce/route.ts",
    ]) {
      const src = read(rel);
      expect(src).toMatch(/(revoke|renounce)GrantAndClearSwitch/);
      // The bare transitions leave sessions behind on purpose — they exist so
      // they can run inside somebody else's transaction. A route reaching for
      // one has skipped the cleanup.
      expect(src).not.toMatch(/\b(revokeGrant|renounceGrant)\(/);
    }
  });
});

/**
 * Structural guards on the record-session fence.
 *
 * The behavioural proofs live in `src/lib/sharing/__tests__/record-session-fence.test.ts`
 * (the verdict and the refusals), `tests/integration/record-session-fence.test.ts`
 * (a refusal before any database work, with a positive control) and
 * `tests/integration/record-session-fence-idempotency.test.ts` (a refusal above
 * the replay cache). Those prove what today's code does. This file freezes what
 * tomorrow's may not do, because the fence has one shape that makes it worth
 * anything:
 *
 *   * exactly two auth helpers consult it, and both consult it BEFORE they read
 *     a carrier or look up a grant;
 *   * the helpers that deliberately do not consult it still do not;
 *   * one file writes the epoch and a closed list reads it;
 *   * the header names live in four files and no fifth: declared in the contract
 *     module, read by the server fence, attached by the browser transport, and
 *     published by the OpenAPI route module.
 *
 * ## What these matchers cannot see
 *
 * Everything here is a text match over source, so the guard's own limit is
 * worth writing down the way `session-surface-guard.test.ts` writes down its
 * own: **a fence bypass under a different header name would slip every matcher
 * below.** A future module that read `x-healthlog-record-context` and made its
 * own admission decision would be invisible here, exactly as the share-link
 * tree was invisible to a sweep that grepped only for `getSession`. The header
 * leg pins the names that exist; it cannot pin the ones that do not yet.
 *
 * Nor can it prove ordering at runtime. The placement legs compare source
 * offsets inside a function body, which is a proxy for execution order and
 * holds only because neither call sits inside a branch. The runtime property —
 * "no grant was looked up" — is proved by the integration file's `lastUsedAt`
 * and `sharing.record.accessed` instruments and by the `findActiveGrant`
 * zero-call spy, not here.
 *
 * Every leg asserts a non-zero match count before it asserts a set, because a
 * guard whose matcher finds nothing reports success, and this repository has
 * shipped several of those.
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";

import { authGuardsText, guardSourceOf } from "./helpers/auth-guards";
import {
  readSource,
  readSourceText,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

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
 * The source text of a top-level exported function, braces included. Same
 * brace-matching walk `acting-account-boundary-guard.test.ts` uses.
 */
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

/**
 * The auth layer: the route wrapper and every guard module it re-exports,
 * joined, with the two record resolvers as anchors so a move that loses them
 * throws instead of leaving the negative legs below green.
 */
const AUTH_LAYER = (() => {
  guardSourceOf("requireRecordAuth", ["requireGuardianAuth"]);
  return [
    readSource("src/lib/api-handler.ts", "apiHandler"),
    authGuardsText(),
  ].join("\n");
})();

/** The two helpers that resolve a record and therefore must consult the fence. */
const FENCED_RESOLVERS = ["requireRecordAuth", "requireGuardianAuth"] as const;

/**
 * The helpers that deliberately do NOT consult the fence.
 *
 * This is a statement about the HELPERS. It must not be read as "no admin route
 * is ever fenced", and it must not be read as the reverse either.
 * `POST /api/admin/backups/[id]/restore` composes `withIdempotency` OUTSIDE
 * `apiHandler`, so the wrapper's fence check runs on it — but that check
 * refuses only the STALE half. An `unfenced-client` verdict falls through to
 * the handler, whose `requireAdmin` is on this list, so a headerless admin
 * request is served exactly as it was before the fence existed. The accurate
 * claim is therefore narrow: an idempotent admin write under a context the
 * client asserted WRONGLY is refused; one that asserts nothing is not.
 *
 * Each entry's reason, once:
 *
 *   * `requireActorAuth` is the way OUT of a switch. Fencing it would make an
 *     unprovable context unrecoverable, and it serves the caller's own rows by
 *     definition, so the selector cannot change what it returns.
 *   * `requireAuth` bare already refuses outright under an active switch, and
 *     its routes are classified actor-only elsewhere.
 *   * `requireAdmin`, `requireCookieAuth` and `requireFreshMfa` resolve through
 *     `getSession()` and are structurally unreachable by a switch.
 */
const UNFENCED_HELPERS = [
  "requireAuth",
  "requireActorAuth",
  "requireAdmin",
  "requireCookieAuth",
  "requireFreshMfa",
] as const;

describe("the fence runs in exactly two auth helpers", () => {
  it("is called by both record resolvers and by nothing else in the auth layer", () => {
    const calls = [
      ...authGuardsText().matchAll(/assertRecordSessionFence\s*\(/g),
    ];
    expect(readSource("src/lib/api-handler.ts", "apiHandler")).not.toMatch(
      /assertRecordSessionFence\s*\(/,
    );
    // Non-zero proof: an emptied file would agree with an emptied expectation.
    expect(calls.length).toBeGreaterThan(0);

    const callers = FENCED_RESOLVERS.filter((name) =>
      functionBody(AUTH_LAYER, name).includes("assertRecordSessionFence("),
    );
    expect(callers).toEqual([...FENCED_RESOLVERS]);
    // Two call sites, one import. Anything else means a third caller appeared.
    expect(calls.length).toBe(FENCED_RESOLVERS.length);
  });

  it.each(FENCED_RESOLVERS)(
    "%s fences after authentication and before the carrier and the grant",
    (name) => {
      const body = functionBody(AUTH_LAYER, name);
      expect(body.length).toBeGreaterThan(100);

      const fence = body.indexOf("assertRecordSessionFence(");
      const authenticate = body.indexOf("authenticateCaller(");
      const carrier = body.indexOf("readActingCarrier(");
      expect(fence).toBeGreaterThan(-1);
      expect(authenticate).toBeGreaterThan(-1);
      expect(carrier).toBeGreaterThan(-1);

      // `authenticateCaller` NECESSARILY precedes the fence: it supplies the
      // session row the fence reads, and the whole atomicity argument rests on
      // both facts coming off that one read. So the invariant is "after
      // authentication, before the carrier" — NOT "before the first database
      // await", which would be false and must not be asserted here.
      expect(fence).toBeGreaterThan(authenticate);
      expect(fence).toBeLessThan(carrier);
    },
  );

  it("fences before any grant lookup in the shared resolver path", () => {
    // `findActiveGrant` lives in `resolveSwitchedRecord`, which both resolvers
    // tail-call. Assert it appears nowhere ABOVE the fence in either body.
    const grantCalls = [...authGuardsText().matchAll(/findActiveGrant\s*\(/g)];
    expect(grantCalls.length).toBeGreaterThan(0);

    for (const name of FENCED_RESOLVERS) {
      const body = functionBody(AUTH_LAYER, name);
      const fence = body.indexOf("assertRecordSessionFence(");
      const grant = body.indexOf("findActiveGrant(");
      // Either the body never names it (it is in the shared tail) or it names
      // it after the fence. Both are the property; neither may invert.
      if (grant !== -1) expect(fence).toBeLessThan(grant);
    }
  });

  it.each(UNFENCED_HELPERS)("%s deliberately does not fence", (name) => {
    const body = functionBody(AUTH_LAYER, name);
    expect(body.length).toBeGreaterThan(50);
    expect(body).not.toContain("assertRecordSessionFence");
  });

  it("the two unfenced routes stay unfenced", () => {
    // `/api/auth/me` is the reconciliation bootstrap and must answer while the
    // client's context is unknown; the switch endpoint is the way out of a
    // context that cannot be proved. Fencing either would make an unprovable
    // context unrecoverable.
    const me = readSource("src/app/api/auth/me/route.ts", "requireActorAuth");
    const sw = readSource(
      "src/app/api/account/switch/route.ts",
      "requireActorAuth",
    );
    expect(me).toContain("requireActorAuth");
    expect(sw).toContain("requireActorAuth");
    expect(me).not.toContain("assertRecordSessionFence");
    expect(sw).not.toContain("assertRecordSessionFence");
  });
});

/**
 * Both lists below grow as the feature lands, and that is the point rather than
 * a defect: the idempotency arm and the browser's adopted-context module each
 * arrive as a visible diff here rather than as a quiet new reader. Same posture
 * as `CARRIER_ALLOWLIST` in `acting-account-boundary-guard.test.ts`.
 */
describe("the epoch has one writer and a closed reader set", () => {
  it("is written in exactly one file", () => {
    // The SQL spelling only. `acting-session.ts` owns the conditional write
    // because it needs `RETURNING`, which no model delegate expresses — and
    // keeping the statement there is what keeps this list at one.
    const writers = filesMatching(/record_epoch/);
    expect(writers.length).toBeGreaterThan(0);
    expect(writers).toEqual(["lib/sharing/acting-session.ts"]);
  });

  it("is read by a closed list and nothing else", () => {
    // The identifier, bounded so `recordEpochParameter` in the OpenAPI module
    // does not count — that file publishes a header name, it does not read a
    // column.
    const readers = filesMatching(/\brecordEpoch(?![\w$])/);
    expect(readers.length).toBeGreaterThan(0);
    expect(readers).toEqual(
      [
        // Projects it off the session row it already loaded.
        "lib/auth/session.ts",
        // Carries it on the auth context the fence is handed.
        "lib/auth/guards/context.ts",
        // Compares it. The one place that decides anything from it.
        "lib/sharing/record-session-fence.ts",
        // Reads it off the same session lookup the idempotency wrapper already
        // makes, so the fence can be evaluated above the replay cache without a
        // second round trip.
        "lib/auth/acting-carrier.ts",
      ].sort(),
    );
  });

  it("is consulted by the idempotency wrapper, above the cache", () => {
    const src = readSource(
      "src/lib/idempotency.ts",
      "refuseStaleRecordSessionClaim(claim)",
    );
    const fence = src.indexOf("refuseStaleRecordSessionClaim(claim)");
    const cache = src.indexOf("findCached(ctx)");
    const claimRow = src.indexOf("claimKey(ctx)");
    expect(fence).toBeGreaterThan(-1);
    expect(cache).toBeGreaterThan(-1);
    expect(claimRow).toBeGreaterThan(-1);
    // A stale request must not learn whether a cell exists, replay a body out
    // of one, or insert a claim row. The runtime proof is the zero-call
    // instrument in `src/lib/__tests__/idempotency.test.ts`; this is the
    // tripwire that says the line moved.
    expect(fence).toBeLessThan(cache);
    expect(fence).toBeLessThan(claimRow);
    // And it comes from the fence module, not from a second copy of the rule.
    expect(src).toContain('from "@/lib/sharing/record-session-fence"');
  });

  it("does not leak the raw counter into the browser's vocabulary", () => {
    // The client never names the epoch as a column. It receives
    // `recordSession: { epoch, scope }` and asserts it back as a header, which
    // is why no file under `hooks/` or `components/` appears in the list above.
    // A client that started naming `recordEpoch` would be reaching past the
    // published shape into the row.
    const clientReaders = filesMatching(/\brecordEpoch(?![\w$])/).filter(
      (rel) =>
        rel.startsWith("hooks/") ||
        rel.startsWith("components/") ||
        rel.startsWith("app/"),
    );
    expect(clientReaders).toEqual([]);
  });
});

describe("the header names live in a closed set of files", () => {
  it("is declared, read and published — and nowhere else", () => {
    // Mirrors the `x-healthlog-account` leg in
    // `acting-account-boundary-guard.test.ts`. A route that started reading
    // these headers itself would be making an admission decision the fence
    // exists to make once.
    const namers = filesMatching(
      /RECORD_EPOCH_HEADER|RECORD_SCOPE_HEADER|x-healthlog-record-(epoch|scope)/i,
    );
    expect(namers.length).toBeGreaterThan(0);
    expect(namers).toEqual([
      // Attaches them to every same-origin request, and validates the echo.
      "lib/api/record-fence.ts",
      // Publishes them to the clients that have to send them.
      "lib/openapi/routes/account-sharing.ts",
      // Declares them.
      "lib/sharing/record-session-fence-contract.ts",
      // Reads them off the request scope, and writes the response echo.
      // `apiHandler` attaches the echo through this module's helper rather than
      // naming the headers itself, which is what keeps this list at four.
      "lib/sharing/record-session-fence.ts",
    ]);
  });

  it("keeps the 409's code in the contract module and the client that branches on it", () => {
    const namers = filesMatching(/sharing\.session\.changed/);
    expect(namers.length).toBeGreaterThan(0);
    // The error class reads the constant rather than restating the string, so
    // `api-handler.ts` is deliberately NOT on this list.
    expect(namers).toContain("lib/sharing/record-session-fence-contract.ts");
  });
});

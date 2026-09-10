/**
 * Every route is published, declared unpublished, or registered as retired.
 *
 * `pnpm openapi:check` compares the registry against `docs/api/openapi.yaml`
 * and fails on drift between them. It has never compared the ROUTES against
 * the registry, so a route that was never registered at all produced no drift
 * and no failure: the spec was internally consistent and silently incomplete.
 * That is how two hundred and twenty-two paths, forty-three of them called by
 * the native client, ended up undocumented while the contract check ran green
 * on every commit for months. The first count taken of this gap said
 * forty-five, because it compared against the paths the YAML already listed
 * rather than against the verbs the routes export.
 *
 * This file closes the third side of the triangle. It walks `src/app` for
 * route modules, reads the HTTP verbs each one actually exports, and requires
 * every verb to be either present in the route table or named in
 * {@link UNPUBLISHED} with a reason. Adding a route without touching either
 * side fails here, which is the only place it can be caught before a client
 * goes looking for a contract that was never written.
 *
 * ## The third state: retired
 *
 * Published and exempted both describe a route that exists. Removing one used
 * to leave exactly one legal move — drop it from the contract too — and that
 * move is invisible to every client already calling it. The native app spent
 * twelve days rendering a permanent error card over a chart because
 * `/api/auth/me/research-mode` went from published to absent with no third
 * thing in between, and a bare 404 reads as a broken deployment rather than a
 * decision.
 *
 * So retirement is a state here rather than a deletion. A path in
 * `RETIRED_ROUTES` is required to be gone from `src/app` AND present in the
 * contract, which is the one combination the fourth case below used to reject
 * outright. Removing a route now forces a choice: drop it from the contract, or
 * register it as retired and let the proxy answer 410 for it. What is no longer
 * available is doing neither and finding out from a client.
 *
 * Be exact about what that is worth, because the obvious overclaim is easy to
 * write and was written here first. This guard reads the tree as it stands. It
 * cannot see a deletion, so it cannot insist that a removal SHOULD have been
 * registered: a route deleted from `src/app` and from its route module in one
 * commit leaves nothing behind to notice, and no check over a single commit's
 * state can recover the fact that something used to be there. Proving otherwise
 * needs an anchor outside the commit — the previous release tag — and the job
 * that runs this suite checks out at depth one with no tags, so a history
 * comparison here would be a check that silently cannot fail.
 *
 * What the third state does buy, and it is not nothing: deleting a route while
 * it is still published now has TWO legal answers instead of one, and the
 * failure message names both. Before, the only way past the fourth case was to
 * erase the path — the move that is invisible to every client. Now the cheaper
 * move is to leave the path standing as a tombstone, which is the move that
 * reaches them. And once registered, the registration is held in three
 * directions by the cases below, so it cannot rot into a lie about a route that
 * came back or a retirement the contract never mentions.
 *
 * ## Why the exemption list carries prose
 *
 * A bare allowlist of paths decays into a place to put things. Each entry here
 * says WHY the route is absent from the public contract, so the next reader can
 * disagree with the reason rather than guess at it, and so an entry whose
 * reason has stopped being true is visible as text rather than as a path in a
 * list. The reasons fall into a small number of kinds — browser-only
 * navigation, an OAuth callback the provider drives, a webhook authenticated by
 * a shared secret, an internal cron trigger — and a route that does not fit one
 * of those kinds probably belongs in the spec.
 *
 * ## What this guard does NOT prove
 *
 * - It proves a verb is PRESENT in the table, not that the operation is
 *   accurate. A published path whose request schema has drifted from the
 *   handler passes here. That is the limit of a structural check; the accuracy
 *   comes from the schemas being imported from `src/lib/validations/*` rather
 *   than retyped.
 * - It reads exports with a regex over comment-stripped source. A verb exported
 *   through an indirection this matcher cannot see would read as absent, which
 *   fails loudly rather than passing quietly, and is the direction an
 *   imprecise matcher should fail in.
 * - `globSync` skips dot-directories by default, which once hid fourteen guards
 *   from `src/app/.well-known`. The sweep below passes an explicit pattern list
 *   that includes it, and asserts a floor on the number of modules found so an
 *   enumeration that silently matches nothing cannot read as full coverage.
 *
 * Mutation checks, each run and confirmed red:
 *
 *   1. Delete any single entry from {@link UNPUBLISHED} → the third case fails
 *      naming that path.
 *   2. Delete a path from a route module → the second case fails naming the
 *      verbs that lost their contract.
 *   3. Delete a live route module that is published — `src/app/api/version` —
 *      → the fourth case fails naming `/api/version` as a published path no
 *      route serves. This is the seam the third state opens: the failure now
 *      has two ways out, erase the path or register the retirement, and the
 *      message says so.
 *   4. Recreate `src/app/api/auth/me/research-mode/route.ts` with a GET export
 *      → the fifth case fails naming it, because a tombstone over a live route
 *      is wrong in three places at once (this contract, the capability list,
 *      and the 410 the proxy answers before the route can ever run).
 *   5. Drop `...retiredPaths` from the route-table index → the sixth case fails
 *      naming every registered path as answered by the server and absent from
 *      the contract.
 *
 * Deliberately NOT claimed: deleting an entry from `RETIRED_ROUTES` does not
 * fail anything here, because the contract entries are generated from that same
 * constant and both sides disappear together. That is the limit stated above,
 * written down so the next reader does not mistake this file for a deletion
 * detector.
 */
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { relative } from "node:path";

import { describe, expect, it } from "vitest";

import { openApiPaths } from "@/lib/openapi/routes";
import { RETIRED_ROUTES } from "@/lib/http/retired-routes";

const ROOT = process.cwd();

/**
 * The verbs a route module can export. `HEAD` and `OPTIONS` are deliberately
 * out: Next.js answers both from the others, and neither is a contract a client
 * writes against.
 */
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * The kinds of route that are deliberately outside the published contract.
 *
 * A kind rather than a free-text reason per path, because these fall into a
 * small number of genuinely different shapes and writing the same sentence
 * seventy-three times would hide the one entry whose sentence is different. A
 * route that fits none of these kinds belongs in the spec.
 */
const REASONS = {
  /**
   * `requireAdmin()` is cookie-only by construction (`src/lib/api-handler.ts`),
   * so a Bearer token cannot reach these however wide its scope. The only
   * caller that can is the operator's own browser on the admin console, which
   * ships with the server and does not read a spec to find out what it talks
   * to. Publishing them would describe an API surface that no API client can
   * use.
   */
  adminConsole:
    "cookie-only admin console; requireAdmin() refuses every Bearer caller",
  /**
   * A browser navigation, not a request a client makes and reads. The response
   * is a redirect to the provider's own authorise page; the client that starts
   * it is a link, and the thing that follows it is the address bar.
   */
  browserHandoff:
    "browser navigation that ends at the provider's authorise page",
  /**
   * Driven by the provider, arriving with the provider's own query string. A
   * client never constructs one, and the contract that governs its shape is
   * the provider's, not this one.
   */
  oauthCallback: "provider-driven redirect back from an OAuth authorise step",
  /**
   * Called by the provider, authenticated by a shared secret rather than by a
   * session or a token. The payload shape is the provider's to define, and
   * documenting it here would suggest a caller could construct one.
   */
  providerWebhook:
    "provider-called, authenticated by a shared secret rather than a session",
  /**
   * Serves the deployment itself: crash reports, web vitals, the analytics
   * proxy, the deploy hook. No user-facing client calls these, and two of them
   * accept a body defined by a browser reporting standard rather than by us.
   */
  internalOps: "serves the deployment itself, not any user-facing client",
  /**
   * The Model Context Protocol transport and the OAuth dance in front of it.
   * These speak wire formats that MCP and RFC 8414 / RFC 7591 define, including
   * error bodies the standard response envelope cannot express, which is why
   * they are the documented exception to the `apiHandler` rule as well.
   */
  mcpTransport: "speaks the MCP and OAuth wire formats, not this envelope",
  /**
   * A clinician share link, authenticated by the URL credential itself. The
   * audience is a person who was sent a link, and the whole point is that they
   * need nothing else — no account, no token, and no contract to read.
   */
  shareLink:
    "authenticated by the URL credential, for a recipient with no account",
  /**
   * A discovery document whose format belongs to somebody else: Apple's
   * associated-domains file, and the two OAuth metadata documents. Their shape
   * is fixed by an external specification, so restating it here would create a
   * second source of truth that can only be wrong.
   */
  wellKnown: "format fixed by an external specification",
} as const;

type ExemptionKind = keyof typeof REASONS;

interface Exemption {
  kind: ExemptionKind;
  /** The verbs this exemption covers. Any other verb must be published. */
  methods: readonly HttpMethod[];
}

/**
 * Routes that are deliberately not in the public contract.
 *
 * Keyed by path, listing the verbs the exemption covers, so a route that grows
 * a new verb has to justify it rather than inherit somebody else's reason.
 */
const UNPUBLISHED: Readonly<Record<string, Exemption>> = {
  "/api/admin/ai-quality": { kind: "adminConsole", methods: ["GET"] },
  "/api/admin/ai-settings": { kind: "adminConsole", methods: ["GET", "PUT"] },
  "/api/admin/app-logs": { kind: "adminConsole", methods: ["GET"] },
  "/api/admin/audit-log": { kind: "adminConsole", methods: ["GET"] },
  "/api/admin/audit-log/actions": { kind: "adminConsole", methods: ["GET"] },
  "/api/admin/backup/test": { kind: "adminConsole", methods: ["POST"] },
  "/api/admin/backups": { kind: "adminConsole", methods: ["GET"] },
  "/api/admin/backups/run": { kind: "adminConsole", methods: ["POST"] },
  "/api/admin/backups/upload": { kind: "adminConsole", methods: ["POST"] },
  // `/api/admin/backups/{id}/download` and `/api/admin/backups/{id}/restore`
  // are published rather than exempted: both open the encrypted stored copy,
  // and the refusal they answer when it will not open is a promise an operator
  // needs to be able to look up. See `src/lib/openapi/routes/admin-backups.ts`.
  "/api/admin/backups/{id}/summary": { kind: "adminConsole", methods: ["GET"] },
  "/api/admin/central-codex": {
    kind: "adminConsole",
    methods: ["DELETE", "GET"],
  },
  "/api/admin/central-codex/device-poll": {
    kind: "adminConsole",
    methods: ["POST"],
  },
  "/api/admin/central-codex/device-start": {
    kind: "adminConsole",
    methods: ["POST"],
  },
  "/api/admin/data": { kind: "adminConsole", methods: ["DELETE"] },
  "/api/admin/drain-per-sample-cumulative": {
    kind: "adminConsole",
    methods: ["POST"],
  },
  "/api/admin/encryption/rotate": { kind: "adminConsole", methods: ["POST"] },
  "/api/admin/encryption/status": { kind: "adminConsole", methods: ["GET"] },
  "/api/admin/host-metrics": { kind: "adminConsole", methods: ["GET"] },
  "/api/admin/import-apple-health-export": {
    kind: "adminConsole",
    methods: ["POST"],
  },
  "/api/admin/monitoring/glitchtip-test": {
    kind: "adminConsole",
    methods: ["POST"],
  },
  "/api/admin/monitoring/umami-test": {
    kind: "adminConsole",
    methods: ["POST"],
  },
  "/api/admin/provider-health": { kind: "adminConsole", methods: ["GET"] },
  "/api/admin/notifications/health": { kind: "adminConsole", methods: ["GET"] },
  "/api/admin/notifications/reminder-check": {
    kind: "adminConsole",
    methods: ["POST"],
  },
  "/api/admin/notifications/test": { kind: "adminConsole", methods: ["POST"] },
  "/api/admin/rollups/recompute": { kind: "adminConsole", methods: ["POST"] },
  "/api/admin/settings": { kind: "adminConsole", methods: ["GET", "PUT"] },
  "/api/admin/settings/assistant-flags": {
    kind: "adminConsole",
    methods: ["GET", "PUT"],
  },
  "/api/admin/settings/module-availability": {
    kind: "adminConsole",
    methods: ["GET", "PATCH"],
  },
  "/api/admin/settings/web-push-vapid/generate": {
    kind: "adminConsole",
    methods: ["POST"],
  },
  "/api/admin/status": { kind: "adminConsole", methods: ["GET"] },
  "/api/admin/tokens": { kind: "adminConsole", methods: ["GET"] },
  "/api/admin/users": { kind: "adminConsole", methods: ["GET"] },
  "/api/admin/users/{id}": { kind: "adminConsole", methods: ["PUT"] },
  "/api/admin/users/{id}/force-logout": {
    kind: "adminConsole",
    methods: ["POST"],
  },
  "/api/admin/users/{id}/reset-password": {
    kind: "adminConsole",
    methods: ["POST"],
  },
  "/api/fitbit/connect": { kind: "browserHandoff", methods: ["GET"] },
  "/api/google-health/connect": { kind: "browserHandoff", methods: ["GET"] },
  // `/api/nightscout/connect` sat here as a `browserHandoff` and is published
  // now. Nightscout has no OAuth step and no authorise page: the route is an
  // authenticated JSON POST that Zod-parses a URL and a token, probes the
  // instance and encrypts the pair onto the row. It was the only POST among
  // eight `connect` entries and the only one whose siblings — status, test,
  // disconnect — were all published, which is what makes it read as an entry
  // that inherited a neighbour's reason rather than earned its own. The seven
  // GET handoffs below keep it: each of those really does end at a provider's
  // authorise page.
  "/api/oura/connect": { kind: "browserHandoff", methods: ["GET"] },
  "/api/polar/connect": { kind: "browserHandoff", methods: ["GET"] },
  "/api/strava/connect": { kind: "browserHandoff", methods: ["GET"] },
  "/api/whoop/connect": { kind: "browserHandoff", methods: ["GET"] },
  "/api/withings/connect": { kind: "browserHandoff", methods: ["GET"] },
  "/api/internal/deploy-webhook": {
    kind: "internalOps",
    methods: ["GET", "POST"],
  },
  "/api/internal/web-vitals": { kind: "internalOps", methods: ["POST"] },
  "/api/monitoring/csp-report": { kind: "internalOps", methods: ["POST"] },
  "/api/monitoring/glitchtip": { kind: "internalOps", methods: ["POST"] },
  "/api/monitoring/settings": { kind: "internalOps", methods: ["GET"] },
  "/api/monitoring/umami-script": { kind: "internalOps", methods: ["GET"] },
  "/api/send": { kind: "internalOps", methods: ["POST"] },
  "/api/mcp/oauth/authorize": {
    kind: "mcpTransport",
    methods: ["GET", "POST"],
  },
  "/api/mcp/oauth/register": { kind: "mcpTransport", methods: ["POST"] },
  "/api/mcp/oauth/token": { kind: "mcpTransport", methods: ["POST"] },
  "/mcp": { kind: "mcpTransport", methods: ["DELETE", "GET", "POST"] },
  "/api/auth/oidc/callback": { kind: "oauthCallback", methods: ["GET"] },
  "/api/fitbit/callback": { kind: "oauthCallback", methods: ["GET"] },
  "/api/google-health/callback": { kind: "oauthCallback", methods: ["GET"] },
  "/api/oura/callback": { kind: "oauthCallback", methods: ["GET"] },
  "/api/polar/callback": { kind: "oauthCallback", methods: ["GET"] },
  "/api/strava/callback": { kind: "oauthCallback", methods: ["GET"] },
  "/api/whoop/callback": { kind: "oauthCallback", methods: ["GET"] },
  "/api/withings/callback": { kind: "oauthCallback", methods: ["GET"] },
  "/api/telegram/webhook": {
    kind: "providerWebhook",
    methods: ["GET", "POST"],
  },
  "/api/whoop/webhook/{token}": { kind: "providerWebhook", methods: ["POST"] },
  "/api/withings/webhook": {
    kind: "providerWebhook",
    methods: ["GET", "POST"],
  },
  "/api/withings/webhook/{token}": {
    kind: "providerWebhook",
    methods: ["GET", "POST"],
  },
  // `/c/{token}/report.pdf` and `/c/{token}/fhir` were exempt here as
  // `shareLink` and are published now. That reason holds for the page a
  // recipient opens; it does not hold for two routes that serve machine
  // formats a practice files into another system, which is precisely the
  // audience a contract has. `/c/{token}/d/{id}` was published all along, one
  // route away in the same tree, which is what makes the exemption read as an
  // oversight rather than a decision. The `shareLink` reason stays: the next
  // recipient-facing route is likelier to want it than not.
  "/.well-known/apple-app-site-association": {
    kind: "wellKnown",
    methods: ["GET"],
  },
  "/.well-known/oauth-authorization-server": {
    kind: "wellKnown",
    methods: ["GET"],
  },
  "/.well-known/oauth-protected-resource": {
    kind: "wellKnown",
    methods: ["GET"],
  },
};

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

/** `src/app/api/foo/[id]/route.ts` → `/api/foo/{id}`. */
function toApiPath(file: string): string {
  return (
    "/" +
    relative("src/app", file)
      .replace(/\/route\.ts$/, "")
      .replace(/\[\.\.\.([A-Za-z0-9_$]+)\]/g, "{$1}")
      .replace(/\[([A-Za-z0-9_$]+)\]/g, "{$1}")
  );
}

function exportedMethods(source: string): HttpMethod[] {
  return HTTP_METHODS.filter((method) =>
    new RegExp(
      `export\\s+(?:async\\s+)?(?:function\\s+${method}\\b|const\\s+${method}\\b)`,
    ).test(source),
  );
}

/**
 * Every route module under `src/app`, dot-directories included.
 *
 * The two patterns are not redundant: `globSync("src/app/**")` does not descend
 * into `.well-known`, and a sweep that quietly skips it is exactly the failure
 * this project has already had once.
 */
function routeModules(): string[] {
  const found = new Set<string>([
    ...globSync("src/app/**/route.ts", { cwd: ROOT }),
    ...globSync("src/app/**/.*/**/route.ts", { cwd: ROOT }),
  ]);
  return [...found].sort();
}

interface DiskRoute {
  path: string;
  methods: HttpMethod[];
}

function routesOnDisk(): DiskRoute[] {
  const routes: DiskRoute[] = [];
  for (const file of routeModules()) {
    const methods = exportedMethods(stripComments(readFileSync(file, "utf8")));
    if (methods.length === 0) continue;
    routes.push({ path: toApiPath(file), methods });
  }
  return routes;
}

describe("every route is published, unpublished, or retired", () => {
  const disk = routesOnDisk();
  const retiredPathSet = new Set(RETIRED_ROUTES.map((route) => route.path));

  it("finds the route modules at all", () => {
    // A floor, not a count: the point is that an enumeration returning nothing
    // cannot read as "everything is covered". The number moves with the tree,
    // so it sits well below the real one.
    expect(
      disk.length,
      "the route sweep found almost nothing, which means the pattern is wrong rather than the tree empty",
    ).toBeGreaterThan(300);
  });

  it("no route verb is missing from the contract without a reason", () => {
    const table = openApiPaths as Record<string, Record<string, unknown>>;
    const undocumented: string[] = [];

    for (const { path, methods } of disk) {
      const exempt = UNPUBLISHED[path];
      const published = table[path] ?? {};
      for (const method of methods) {
        if (exempt?.methods.includes(method)) continue;
        if (method.toLowerCase() in published) continue;
        undocumented.push(`${method} ${path}`);
      }
    }

    expect(
      undocumented,
      "these routes answer requests and no client can read what they answer with",
    ).toEqual([]);
  });

  it("the exemption list names routes that exist", () => {
    const byPath = new Map(disk.map((route) => [route.path, route.methods]));
    const stale: string[] = [];

    for (const [path, exempt] of Object.entries(UNPUBLISHED)) {
      const methods = byPath.get(path);
      if (!methods) {
        stale.push(`${path} (no such route)`);
        continue;
      }
      for (const method of exempt.methods) {
        if (!methods.includes(method)) {
          stale.push(`${method} ${path} (route does not export it)`);
        }
      }
    }

    expect(
      stale,
      "an exemption for a route that is gone hides the next route that needs one",
    ).toEqual([]);
  });

  it("the exemption list names routes that are not published after all", () => {
    // The other way an entry goes stale, and the one this list had: a route
    // gets published and its exemption stays behind, so the list reads as
    // larger than it is and the reason attached to it looks load-bearing when
    // nothing rests on it. Two share-link routes sat here in exactly that
    // state, beside a published sibling in the same tree.
    const table = openApiPaths as Record<string, Record<string, unknown>>;
    const redundant: string[] = [];

    for (const [path, exempt] of Object.entries(UNPUBLISHED)) {
      for (const method of exempt.methods) {
        if (method.toLowerCase() in (table[path] ?? {})) {
          redundant.push(`${method} ${path}`);
        }
      }
    }

    expect(
      redundant,
      "these operations are published AND exempt, so the exemption states a reason nothing depends on",
    ).toEqual([]);
  });

  it("the contract does not publish a path that no route serves, unless it is retired", () => {
    const byPath = new Set(disk.map((route) => route.path));
    const phantom = Object.keys(openApiPaths).filter(
      (path) => !byPath.has(path) && !retiredPathSet.has(path),
    );

    expect(
      phantom,
      "a published path with no route behind it is a promise the deployment cannot keep — register it in RETIRED_ROUTES if it is gone on purpose",
    ).toEqual([]);
  });

  it("a retired path is really gone from src/app", () => {
    // The other direction of the exemption above. A tombstone standing over a
    // route that still answers would publish 410 as the only response while
    // the proxy short-circuits the live handler — the contract, the capability
    // list and the runtime would all be wrong together, and each of them looks
    // internally consistent on its own.
    const byPath = new Set(disk.map((route) => route.path));
    const undead = RETIRED_ROUTES.map((route) => route.path).filter((path) =>
      byPath.has(path),
    );

    expect(
      undead,
      "these paths are registered as retired and a route module still exports verbs for them",
    ).toEqual([]);
  });

  it("every retired path is published as gone", () => {
    // Registering a retirement and not publishing it puts a client back where
    // it started: the proxy answers 410, and a client generated from the
    // contract has never heard of the path. The retirement is only worth
    // anything if it reaches the reader.
    const table = openApiPaths as Record<string, Record<string, unknown>>;
    const unpublished: string[] = [];

    for (const route of RETIRED_ROUTES) {
      const published = table[route.path];
      if (!published) {
        unpublished.push(`${route.path} (absent from the contract)`);
        continue;
      }
      for (const method of route.methods) {
        const operation = published[method.toLowerCase()] as
          { responses?: Record<string, unknown> } | undefined;
        if (!operation) {
          unpublished.push(`${method} ${route.path} (verb not published)`);
          continue;
        }
        if (!operation.responses?.["410"]) {
          unpublished.push(`${method} ${route.path} (published without a 410)`);
        }
      }
    }

    expect(
      unpublished,
      "these retirements are answered by the server and invisible in the contract",
    ).toEqual([]);
  });
});

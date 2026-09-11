/**
 * Routes that existed, answered requests, and are gone.
 *
 * A route removed on purpose still leaves a client calling it. As reported in
 * iOS #94: between 2026-08-08 and 2026-08-20 the native client asked
 * `/api/auth/me/research-mode` on every GLP-1 detail screen, got a bare 404,
 * and painted a permanent error card with a retry button aimed at the same
 * removed path. Twelve days, on every reachable instance including the public
 * demo, which was built after the removal. Nothing about deleting the route was
 * wrong — the removing commit reasons the decision out and states the target
 * state for clients in words. What was wrong is that
 * the answer said nothing: a 404 from a deployment is indistinguishable from a
 * broken build, a reverse proxy pointed at the wrong upstream, or a typo in the
 * client's own path, so treating it as transient and retrying is the correct
 * reading of the only evidence the client had.
 *
 * ## Why 410 and not a 404 with a code
 *
 * Both were on the table. 410 wins because it is the status whose entire
 * meaning is "this existed here and is gone", so a client that understands
 * nothing else about this API — a generated stub, a retry policy written years
 * ago, an HTTP cache — still learns not to retry. A 404 carrying
 * `meta.errorCode` only reaches a client that reads our envelope AND branches
 * on that field, which is the client we already have and not the one that broke.
 * The error code is not dropped: it rides along in the same envelope, so a
 * client that does read the body gets the removing version and the replacement
 * as well. The status is the floor; the code is the detail.
 *
 * ## Where the answer is produced
 *
 * `src/proxy.ts`, before routing. Not a catch-all route module, for two
 * reasons. A catch-all under `/api` would intercept every unmatched path, so
 * the ordinary 404 for a genuinely unknown path would become ours to
 * manufacture — a much larger blast radius than the problem. And the proxy
 * already owns the exact-path decisions of this shape (the legacy 301 tables,
 * the public-path allowlist, the demo-mode block), so this is the table that
 * already exists rather than a new mechanism beside it.
 *
 * The answer needs no session and reveals nothing a 404 would not: the set
 * below is a compile-time constant, identical for an anonymous caller and an
 * authenticated one, and it names only paths that were public knowledge in the
 * published contract while they lived. It is not an authentication oracle
 * because it never consults the request's credentials at all.
 *
 * ## What goes in this list
 *
 * The rule is reachability, not evidence of a victim: a path belongs here when
 * something outside this repository could hold a reference to it, meaning it
 * was in the published contract or was a documented surface a client could be
 * built against. A tombstone is worth writing whether or not anything is still
 * calling — it costs one row, and the alternative is a 404 that means nothing.
 *
 * Whether a particular client still calls one of these is a SEPARATE question
 * and this file does not answer it. It cannot: that evidence lives in the
 * client's repository, not in this one, and an inference drawn from this side
 * would be a guess wearing a citation. Nothing below is a claim about a caller.
 *
 * How the set was seeded: every route path under `src/app` at every release
 * tag, unioned, then differenced against the current tree. Twenty-seven paths
 * had been removed across the project's history up to that point. Five of them
 * were published or client-facing and are the first five entries below; the
 * other twenty-two are admin-console routes, operator diagnostics, aggregators
 * superseded in place, and the moodLog bridge — surfaces reachable only from
 * the operator's own browser, which ships with the server and reads no
 * contract to find out what it talks to. `moodlog-removal-guard.test.ts`
 * separately holds that bridge removed. Every entry after those five was
 * written by the release that removed the path, which is where a tombstone
 * belongs.
 *
 * Sample tags instead of all of them and this undercounts badly: six evenly
 * spaced tags find fourteen of the twenty-seven, because a path added and
 * removed between two samples is invisible to both.
 *
 * An entry is permanent. The point of a tombstone is that it outlives the
 * memory of the removal, so entries accumulate rather than being pruned once
 * they "must have been noticed by now".
 *
 * `src/__tests__/openapi-route-coverage-guard.test.ts` holds the three ends
 * together: every path here is absent from `src/app`, published in the
 * contract, and the only kind of published path allowed to have no route
 * behind it.
 */

/** Verbs a route module can export. Mirrors the coverage guard's set. */
export type RetiredMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RetiredRoute {
  /** The path as it was published, in OpenAPI template form. */
  readonly path: string;
  /** The release the removal shipped in, without the `v`. */
  readonly removedIn: string;
  /** Where the capability went, or null when it went nowhere. */
  readonly replacedBy: string | null;
  /** One sentence a client author can act on. */
  readonly reason: string;
  /**
   * The verbs the route exported before it was removed, which is what the
   * contract publishes as gone. Every verb answers 410 regardless — the path
   * is what was retired, not a selection of methods on it.
   */
  readonly methods: readonly RetiredMethod[];
}

/**
 * `meta.errorCode` on every retirement answer. One code, not one per route:
 * the branch a client needs is "gone, stop retrying", and the path it asked
 * for already says which one.
 */
export const RETIRED_ROUTE_ERROR_CODE = "route.retired";

/** HTTP status every retired path answers with. */
export const RETIRED_ROUTE_STATUS = 410;

export const RETIRED_ROUTES: readonly RetiredRoute[] = [
  {
    path: "/api/bugreport",
    removedIn: "1.23.0",
    replacedBy: null,
    reason:
      "The in-app bug reporter forwarded a description to a GitHub issue on the operator's behalf. It was removed with its tables; report through the project's issue tracker instead.",
    methods: ["POST"],
  },
  {
    path: "/api/bugreport/status",
    removedIn: "1.23.0",
    replacedBy: null,
    reason:
      "Told a client whether the in-app bug reporter was configured. Removed with the reporter itself.",
    methods: ["GET"],
  },
  {
    path: "/api/auth/me/doctor-report-prefs",
    removedIn: "1.32.39",
    replacedBy: "/api/auth/me/report-selection",
    reason:
      "The doctor report grew a per-leaf selection, and the old preference blob could not express it. The replacement stores the same intent against the current leaf catalogue.",
    methods: ["GET", "PUT"],
  },
  {
    path: "/api/fhir/$everything",
    removedIn: "1.32.39",
    replacedBy: "/api/fhir/Patient/$everything",
    reason:
      "The whole-record operation moved under the resource type it operates on, which is where FHIR R4 defines it and where the capability statement points.",
    methods: ["GET"],
  },
  {
    path: "/api/auth/check-user",
    removedIn: "1.38.19",
    replacedBy: null,
    reason:
      "Took an email address or a username and answered, to any caller and with no credential at all, whether an account existed here and whether it carried a passkey or a password. It was built to decide which field a sign-in screen shows first, which is not worth telling the world who has an account. Send the credential to POST /api/auth/login or run the passkey ceremony and read the answer; both refuse identically whether or not the account exists.",
    methods: ["POST"],
  },
  {
    path: "/api/auth/me/research-mode",
    removedIn: "1.37.2",
    replacedBy: null,
    reason:
      "Research Mode was an opt-in for the estimated drug-level curve. The chart had stopped consulting the flag several releases earlier and painted for every account regardless, so the switch governed nothing. The curve is simply part of the medication page now and needs no preference read.",
    methods: ["GET", "POST", "DELETE"],
  },
];

const BY_PATH: ReadonlyMap<string, RetiredRoute> = new Map(
  RETIRED_ROUTES.map((route) => [route.path, route]),
);

/**
 * The retirement for this exact path, or undefined.
 *
 * Exact match, deliberately: a prefix would swallow paths that never existed
 * and turn an honest 404 into a claim about history. None of the registered
 * paths carry a template segment today; one that did would be matched here by
 * its literal form and would need a matcher rather than a lookup.
 */
export function findRetiredRoute(pathname: string): RetiredRoute | undefined {
  return BY_PATH.get(pathname);
}

/**
 * The response body, in the standard error envelope.
 *
 * Built as a plain object rather than through `apiError` because this is
 * consumed by the proxy, which bundles separately from the route tree;
 * `proxy-retired-routes.test.ts` proves the two produce identical bytes, so
 * "the standard envelope" is a checked claim rather than a copied shape.
 */
export function retiredRouteEnvelope(route: RetiredRoute) {
  return {
    data: null,
    error: `This endpoint was removed in v${route.removedIn} and is not coming back. Do not retry.`,
    meta: {
      errorCode: RETIRED_ROUTE_ERROR_CODE,
      removedIn: route.removedIn,
      replacedBy: route.replacedBy,
    },
  };
}

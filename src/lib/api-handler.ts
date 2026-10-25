/**
 * The route wrapper: the wide event, the error envelope, the record-context
 * echo and the rate-limit headers around every API handler.
 *
 * It is also the one public entry for the request guards. They live under
 * `./auth/guards/`, one module per family (the caller, the record modes, the
 * cookie-only helpers, the step-up gates), and are re-exported below so a
 * route imports `apiHandler` and its guard from the same place.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  applyBypassRouteHeaders,
  bypassRouteRefusal,
  isProxyBypassRoute,
} from "@/lib/http/proxy-bypass-routes";
import { WideEventBuilder } from "./logging/event-builder";
import { annotate, eventStorage } from "./logging/context";
import { emitIfSampled } from "./logging/transports";
import { redactOptional, redactSecrets } from "./logging/redact";
import { routeTemplateFor } from "./logging/route-template";
import { AiUnavailableError } from "./ai/capabilities/refusal";
import { ConsentRequiredError } from "./ai/consent-guard";
import { attachRecordContextEcho } from "./sharing/record-session-fence";
import { refuseOnKeyMismatch } from "./boot/key-mismatch-refusal";
import { acceptIncomingRequestId } from "./http/request-id";
import { getClientIp, withErrorEnvelopeDefaults } from "./api-response";
import { refuseCrossSiteWrite } from "./http/cross-site-guard";
import {
  capturedRateLimit,
  rateLimitResponseHeaders,
  runWithRateLimitCapture,
} from "./rate-limit-context";

export {
  recentProofMethods,
  type RecentProofMethod,
} from "./auth/second-factor";

// The error classes live in the LEAF module `api-errors.ts` (moved to break
// the api-handler ↔ record-session-fence import cycle) and are re-exported
// here so the hundreds of existing importers read exactly as before.
import {
  AccountDeletionPendingError,
  AUTH_ERROR_CODES,
  HttpError,
  SharingAuthError,
  SharingAccessDeniedError,
  SharingNotPermittedError,
  RecordSessionChangedError,
  StepUpRequiredError,
} from "./api-errors";

export {
  AccountDeletionPendingError,
  AUTH_ERROR_CODES,
  HttpError,
  SharingAuthError,
  SharingAccessDeniedError,
  SharingNotPermittedError,
  RecordSessionChangedError,
  StepUpRequiredError,
};

/**
 * Wraps an API route handler with Wide Event logging.
 * Creates a WideEventBuilder, runs the handler inside AsyncLocalStorage,
 * catches errors, and emits the event on completion.
 *
 * No CSRF check — HealthLog does not use CSRF tokens.
 * Auth annotation happens in routes via requireAuth().
 */
// Read a property from a request-like value without invoking native
// private-field getters (NextRequest.method / .url / .headers access
// `this.#state` and crash with `Cannot read private member #state from
// an object whose class did not declare it` when the request is a
// Proxy or a synthetic placeholder — Next 16 passes such placeholders
// to `force-static` route handlers during dev). We probe defensively
// and fall back to safe defaults so logging instrumentation never
// crashes the handler.
//
// The catch is narrowed to two well-known shapes: the V8 private-field
// TypeError, and the `Cannot read properties of undefined/null` shape
// raised when the wrapper is invoked without a request (vitest tests
// frequently invoke handlers as `GET()` with no args, mirroring the
// shape Next.js exercises for the static-export pass). Any other
// exception is a real bug in the read callback or in a downstream
// header parser and must surface — swallowing it would hide
// regressions in production instrumentation.
function isTolerableRequestProbeError(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  const msg = err.message ?? "";
  return (
    // V8 — current
    msg.includes("private member") ||
    // V8 — alternative
    msg.includes("private field") ||
    // Bun / older V8
    msg.includes("private name") ||
    // No request handed in at all (vitest direct-invoke or
    // force-static placeholder reduced to undefined / null).
    // Covers both modern `Cannot read properties of undefined
    // (reading 'X')` and the older `Cannot read property 'X' of
    // undefined` wordings.
    /Cannot read propert(?:y|ies)\b.*\bof (?:undefined|null)\b/.test(msg)
  );
}

function safeRequestProp<R>(
  request: unknown,
  read: (req: NextRequest) => R,
  fallback: R,
): R {
  try {
    return read(request as NextRequest);
  } catch (err) {
    if (isTolerableRequestProbeError(err)) {
      // v1.4.27 — surface every fallback so a real read
      // regression cannot hide behind the tolerated-error narrowing.
      // Vitest direct-invoke and the force-static placeholder path are
      // the two known-quiet shapes; anything else worth a look should
      // show up in the dev console + the run log.
      if (process.env.NODE_ENV !== "test") {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[api-handler] safeRequestProp fallback — tolerable error: ${msg}`,
        );
      }
      return fallback;
    }
    throw err;
  }
}

/**
 * A state change a browser sent from another site, refused before auth and
 * before the handler (`./http/cross-site-guard.ts`).
 */
function crossSiteRefusal(request: unknown, pathname: string): Response | null {
  const refused = safeRequestProp(
    request,
    (r) => refuseCrossSiteWrite(r, pathname),
    null,
  );
  if (!refused) return null;
  annotate({
    action: { name: "http.cross_site.refused" },
    meta: { reason: refused.reason },
  });
  return refused.response;
}

/** @internal — exposed for unit tests of the narrow-catch contract. */
export const __testables = {
  safeRequestProp,
  isTolerableRequestProbeError,
};

// Next.js route handlers come in two shapes — `(request)` for static routes
// and `(request, { params })` for dynamic ones. The variadic generic is the
// only signature TS accepts that covers both at the call site. The `any[]`
// here is constrained by the bound (T must return Promise<Response>) so it
// does not loosen handler bodies — only their parameter list.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apiHandler<T extends (...args: any[]) => Promise<Response>>(
  handler: T,
): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped = async (...args: any[]): Promise<Response> => {
    const request = args[0] as NextRequest;
    const requestUrl = safeRequestProp(request, (r) => r.url, "");
    const url = (() => {
      try {
        return new URL(requestUrl);
      } catch {
        // No usable URL (e.g. force-static placeholder) — fall back to
        // a synthetic origin so the rest of the pipeline can still
        // attach a pathname.
        return new URL("http://localhost/");
      }
    })();

    // A route the proxy matcher leaves out (large uploads, see
    // `proxy-bypass-routes.ts`) gets the proxy's refusals and headers here.
    const isBypassRoute = isProxyBypassRoute(url.pathname);
    if (isBypassRoute) {
      const refusal = bypassRouteRefusal(
        safeRequestProp(request, (r) => r.method, "GET"),
      );
      if (refusal) {
        applyBypassRouteHeaders(refusal.headers);
        return refusal;
      }
    }

    const evt = new WideEventBuilder("http");

    // Propagate x-request-id when it is a well-formed token. A malformed one
    // never reaches the log or the response; the event keeps its fresh id.
    const incomingRequestId = acceptIncomingRequestId(
      safeRequestProp(request, (r) => r.headers.get("x-request-id"), null),
    );
    if (incomingRequestId) evt.setRequestId(incomingRequestId);

    evt.setHttp({
      method: safeRequestProp(request, (r) => r.method, "GET"),
      path: url.pathname,
      // The handler's template (`/api/medications/[id]`), not the concrete
      // path: one route per handler, so dashboards can group on it.
      route: await routeTemplateFor(url.pathname, args[1]),
      status: 200,
      user_agent:
        safeRequestProp(request, (r) => r.headers.get("user-agent"), null) ??
        undefined,
      // The resolved client address, not the raw leftmost forwarding entry
      // a direct caller could have written itself.
      ip: safeRequestProp(request, (r) => getClientIp(r), null) ?? undefined,
    });

    return runWithRateLimitCapture(() =>
      eventStorage.run(evt, async () => {
        let response: Response | undefined;
        try {
          // The boot key check found that the configured encryption key
          // cannot open this database. Refuse before auth, before the
          // handler: nothing here may read or write encrypted data.
          const refusal =
            refuseOnKeyMismatch(url.pathname) ??
            crossSiteRefusal(request, url.pathname);
          if (refusal) {
            response = refusal;
          } else {
            response = await handler(...args);
          }
        } catch (error) {
          if (error instanceof AiUnavailableError) {
            // An AI capability is unavailable for this record. One envelope
            // for every reason, keeping every code a shipped client already
            // branches on: `meta.errorCode` plus the `capability` and the
            // outermost `reason`, and `module` where the reason is about one.
            // See `src/lib/ai/capabilities/gate.ts` for the table.
            evt.setError(error);
            response = NextResponse.json(
              { data: null, error: error.message, meta: error.meta },
              { status: error.status },
            );
          } else if (error instanceof ConsentRequiredError) {
            // v1.12.1 — server-side consent gate before external-LLM PHI
            // egress on the operator's server-managed key. 403 +
            // meta.errorCode, like the capability refusal above, so the
            // iOS client renders an inline "grant consent" notice instead of
            // a generic failure.
            evt.setError(error);
            response = NextResponse.json(
              {
                data: null,
                error: error.message,
                meta: { errorCode: error.errorCode },
              },
              { status: 403 },
            );
          } else if (error instanceof StepUpRequiredError) {
            // v1.23 — step-up gate not satisfied. Same 401 + meta.errorCode
            // envelope shape as the assistant/consent gates so the client can
            // branch on the stable code and launch a re-verification flow.
            // Checked before the generic HttpError branch because
            // StepUpRequiredError extends it.
            evt.setError(error);
            response = NextResponse.json(
              {
                data: null,
                error: error.message,
                meta: { ...error.extraMeta, errorCode: error.errorCode },
              },
              { status: error.statusCode },
            );
          } else if (error instanceof SharingAuthError) {
            // v1.36.0 — the acting-account resolver refused. Same
            // 403 + meta.errorCode envelope as the gates above, so a client
            // distinguishes "you may not act as that account" from "this
            // endpoint does not support acting on one" without parsing prose.
            // Checked before the generic HttpError branch because it extends it.
            evt.setError(error);
            response = NextResponse.json(
              {
                data: null,
                error: error.message,
                meta: { errorCode: error.errorCode },
              },
              { status: error.statusCode },
            );
          } else if (error instanceof HttpError) {
            // `meta.errorCode` only when the throw site named one, so every
            // HttpError without a code serialises byte-identically to before.
            evt.setError(error);
            response = NextResponse.json(
              {
                data: null,
                error: error.message,
                ...(error.errorCode
                  ? { meta: { ...error.extraMeta, errorCode: error.errorCode } }
                  : {}),
              },
              { status: error.statusCode },
            );
          } else if (error instanceof SyntaxError) {
            evt.setError(error);
            response = NextResponse.json(
              { data: null, error: "Invalid JSON body" },
              { status: 400 },
            );
          } else {
            evt.setError(error);
            // Report to GlitchTip (fire-and-forget)
            reportToGlitchtip(error, request, evt).catch(() => {});
            response = NextResponse.json(
              { data: null, error: "Interner Serverfehler" },
              { status: 500 },
            );
          }
        } finally {
          const status = (response as Response | undefined)?.status ?? 500;
          evt.finish(status);
          try {
            emitIfSampled(evt.toJSON());
          } catch {
            /* logging must never crash the handler */
          }
        }
        // Every error envelope names its request id in `meta.requestId`, so
        // the id survives a proxy that strips the header, and carries a
        // `meta.errorCode`, the status's default when the route named none
        // (see `withErrorEnvelopeDefaults`).
        const nr = (await withErrorEnvelopeDefaults(
          response as Response,
          evt.getRequestId(),
        )) as NextResponse;
        nr.headers.set("x-request-id", evt.getRequestId());
        if (isBypassRoute) applyBypassRouteHeaders(nr.headers);
        // v1.37.0 — echo the record context this response was actually served
        // under, when one was decided. The value comes from the wide event and
        // from nowhere else: the fence stamps it on every call it makes, so
        // exactly the responses that resolved a record scope carry it and
        // everything else — public routes, actor surfaces, admin, `/me`, static —
        // carries nothing.
        //
        // Deliberately NOT derived here with a `getSession()`. That would put a
        // session read on every public route, and it would make the echo a second
        // derivation of the context rather than a report of the one that was
        // used, which is the difference between "what this response served" and
        // "what a later read thinks is true".
        //
        // Absence is therefore meaningful and safe: the client discards a
        // response whose echo CONTRADICTS its adopted context, and serves one
        // that carries no echo normally. A discard-on-absence rule would throw
        // away the `/api/version` poll on every cycle.
        //
        // The two header names stay inside the fence module, which is what keeps
        // them to four files overall (declared, read, attached client-side,
        // published) — see `src/__tests__/record-session-fence-guard.test.ts`.
        attachRecordContextEcho(nr.headers, evt.getRecordContext());
        attachRateLimitHeaders(nr);
        return nr;
      }),
    );
  };
  return wrapped as T;
}

/**
 * Put the rate-limit headers on a refusal that left the handler without them.
 *
 * Only ~70 of the 199 route files that consult a limiter attach
 * `rateLimitHeaders(rl)` by hand; the rest answer 429 with a bare prose
 * envelope, so an offline replay queue that trips the batch ceiling has
 * nothing to back off against but a guess. The limiter records its verdict in
 * the request-scoped cell, so the headers can be derived here for every one of
 * them at once instead of being threaded through each call site — and a route
 * added tomorrow gets them without knowing this exists.
 *
 * `Retry-After` is the presence test rather than a flag: a handler that built
 * its own headers already carries it (they come from the same builder), so
 * this leaves that response exactly as it was written.
 *
 * The cell holds refusals only, so a 429 no limiter produced — a spent daily
 * AI budget, an hourly generation quota, a provider-side 429 relayed onward —
 * reads null here and goes out undressed. There is no bucket to describe, and
 * one that still has room would name a delay against the wrong window.
 */
function attachRateLimitHeaders(response: NextResponse): void {
  if (response.status !== 429) return;
  if (response.headers.has("Retry-After")) return;
  const snapshot = capturedRateLimit();
  if (!snapshot) return;
  for (const [name, value] of Object.entries(
    rateLimitResponseHeaders(snapshot),
  )) {
    response.headers.set(name, value);
  }
}

// The guards live under `./auth/guards/`, one module per family; this module
// is their one public entry, so a route imports the wrapper and its guard
// from the same place.
export {
  isMcpAudienceToken,
  isScopedCredential,
  type AuthContext,
} from "./auth/guards/context";
export {
  requireAuth,
  requireBearerAuth,
  type BearerAuthContext,
} from "./auth/guards/caller";
export {
  requireActorAuth,
  requireGuardianAuth,
  requireRecordAuth,
  type RecordAuthContext,
  type RecordAuthOptions,
} from "./auth/guards/record";
export { requireAdmin, requireCookieAuth } from "./auth/guards/cookie";
export {
  MFA_STEP_UP_MAX_AGE_SECONDS,
  type FreshFactorProofSource,
} from "./auth/guards/fresh-factor";
export {
  requireFreshMfa,
  requireFreshMfaIfEnrolled,
  requireFreshMfaOrElevationIfEnrolled,
  type ErasureAuthContext,
  type FreshMfaContext,
} from "./auth/guards/fresh-mfa";
export {
  assertRecentCookieProof,
  requireRecentProof,
  type RecentProofBearerRule,
} from "./auth/guards/recent-proof";
export { STEP_UP_ELEVATION_HEADER } from "./auth/guards/elevation";
export {
  requireMfaManagementAuth,
  type MfaManagementContext,
} from "./auth/guards/mfa-management";

/**
 * The selector header's name, re-exported.
 *
 * It is declared beside the carrier reader it belongs to; every route-facing
 * helper is imported from this module, and the OpenAPI table and the suites
 * that drive a switched request were written against that path.
 */
export { ACCOUNT_SELECTOR_HEADER } from "./auth/acting-carrier";

/**
 * Report unhandled errors to GlitchTip (fire-and-forget).
 * Uses dynamic import to avoid circular dependencies and startup cost.
 */
async function reportToGlitchtip(
  error: unknown,
  request: NextRequest,
  evt: WideEventBuilder,
): Promise<void> {
  const [{ getGlitchtipSettings }, { sendGlitchtipEvent }] = await Promise.all([
    import("@/lib/monitoring-settings"),
    import("@/lib/monitoring/glitchtip"),
  ]);

  const settings = await getGlitchtipSettings();
  if (!settings.glitchtipEnabled || !settings.glitchtipDsn) return;

  const err =
    error instanceof Error
      ? error
      : new Error(typeof error === "string" ? error : "Unknown error");

  // Skip expected errors from bot scanners (malformed JSON bodies)
  if (err instanceof SyntaxError) return;

  // Audit H-B7 / phase P2: strip the query string before forwarding to
  // GlitchTip. Withings legacy callbacks ship `?secret=…` (see C-3) and
  // OAuth callbacks ship `?code=…&state=…`; if any of those error we
  // don't want their secrets in someone's incident UI.
  const rawUrl = safeRequestProp(request, (r) => r.url, "");
  let scrubbedUrl = rawUrl;
  try {
    const u = new URL(rawUrl);
    u.search = "";
    scrubbedUrl = u.toString();
  } catch {
    // Invalid URL — fall through with the raw value (only happens in
    // degenerate test fixtures).
  }

  await sendGlitchtipEvent({
    dsn: settings.glitchtipDsn,
    input: {
      environment: settings.glitchtipEnvironment || "production",
      // Defence in depth: even though the WideEventBuilder already
      // redacts on `setError()`, the GlitchTip path imports `err`
      // directly. Apply the same redaction here so a Telegram bot
      // token or external Bearer cannot leak via the incident UI.
      message: redactSecrets(err.message),
      level: "error",
      type: err.name || "Error",
      stack: redactOptional(err.stack),
      // Query string is already stripped above, but path-segment secrets
      // (e.g. `/api/withings/webhook/<secret>`, `/api/whoop/webhook/<secret>`)
      // survive that strip. Run the same `redactSecrets` pass that guards the
      // message/stack so a `PATH_SECRET_PATHS`-registered secret cannot reach
      // the external incident UI.
      url: redactSecrets(scrubbedUrl),
      sourceTag: "healthlog-api-handler",
      requestId: evt.getRequestId(),
    },
  });
}

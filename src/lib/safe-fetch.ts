import { fetch as undiciFetch } from "undici";
import { isPublicUrl } from "@/lib/validations/notifications";
import {
  getPinnedOperatorApprovedDispatcher,
  getPinnedPublicDispatcher,
} from "@/lib/safe-fetch-dispatcher";

/**
 * Defaults applied to every `safeFetch` call. Centralised so the values
 * stay greppable and a future audit can verify the convention in one
 * place rather than spread across ~20 outbound call sites.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

export type SafeFetchErrorKind = "private_host" | "timeout" | "network";

export interface SafeFetchOptions {
  /**
   * Follow 3xx responses. Defaults to `false`, i.e. `init.redirect` is
   * pinned to `"manual"`. The opt-in exists so a caller with a legitimate
   * redirect-following need (e.g. resolving a CDN's URL chain) can ask for
   * the WHATWG default; flipping the convention from "remembered to opt
   * in to manual" to "remembered to opt out" was the whole point of
   * issue #218.
   */
  followRedirects?: boolean;
  /**
   * Override the default 15 000 ms timeout. The timeout is composed with
   * any caller-supplied `init.signal` via `AbortSignal.any`, so whichever
   * fires first wins.
   */
  timeoutMs?: number;
  /**
   * When true, run `isPublicUrl(url)` before dispatching. Throws
   * `SafeFetchError({ kind: "private_host" })` if the URL points at an
   * internal range, the cloud metadata endpoint, or any of the IPv4 /
   * IPv6 alt-notation classes `isPublicUrl` catches. The DNS-rebinding
   * follow-up (issue #217) extends this same flag with a connect-time
   * IP pin via a dedicated undici dispatcher.
   */
  requirePublicHost?: boolean;
  /**
   * Exact server-approved origin for a deliberately private destination.
   *
   * This is a server-side trust grant, not request metadata: callers must
   * derive it from operator configuration after exact-origin validation.
   * `safeFetch` verifies the target still has this origin, forbids redirects,
   * and routes the connect through the private-capable pinned dispatcher.
   * It is mutually exclusive with `requirePublicHost`.
   */
  operatorApprovedPrivateOrigin?: string;
  /**
   * Optional caller-owned signal. Composed with the timeout signal so a
   * caller-side abort still wins even when the timeout has not yet
   * elapsed.
   */
  signal?: AbortSignal;
}

/**
 * Typed wrapper around outbound fetch failures so callers can switch
 * on `err.kind` instead of doing brittle string matching against
 * `AbortError` / `TypeError`. Native fetch errors surface as
 * `kind: "network"`; timeouts become `kind: "timeout"`; input-time
 * private-host rejections become `kind: "private_host"`.
 */
export class SafeFetchError extends Error {
  readonly kind: SafeFetchErrorKind;
  readonly cause?: unknown;

  constructor(message: string, kind: SafeFetchErrorKind, cause?: unknown) {
    super(message);
    this.name = "SafeFetchError";
    this.kind = kind;
    if (cause !== undefined) this.cause = cause;
  }
}

function composeSignals(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!caller) return timeout;
  return AbortSignal.any([caller, timeout]);
}

function hasPrivateHostPolicyCause(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    safeFetchKind?: unknown;
    cause?: unknown;
    errors?: unknown[];
  };
  return (
    value.safeFetchKind === "private_host" ||
    hasPrivateHostPolicyCause(value.cause) ||
    (value.errors ?? []).some(hasPrivateHostPolicyCause)
  );
}

/** Hops a followed redirect chain may take before it is refused. */
const MAX_REDIRECTS = 5;

/**
 * Follow redirects one hop at a time, putting every new location through
 * `isPublicUrl` before it is dialled.
 *
 * The pinned dispatcher vets an address in its DNS lookup, and Node never
 * looks up an IP literal, so a redirect to `http://169.254.169.254/` would
 * have been dialled without a check: the input-time `isPublicUrl` had only
 * seen the first URL. A 301, 302 or 303 continues as a GET without a body,
 * as fetch does; a 307 or 308 repeats the request only when it has no body
 * to send again.
 */
async function followCheckingEachHop(
  start: string,
  init: RequestInit,
  dispatcher: NonNullable<Parameters<typeof undiciFetch>[1]>["dispatcher"],
): Promise<Response> {
  let url = start;
  let current: RequestInit = { ...init, redirect: "manual" };
  for (let hop = 0; ; hop++) {
    const res = (await undiciFetch(url, {
      ...current,
      dispatcher,
    } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) return res;
    void res.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) {
      throw new SafeFetchError(
        "safeFetch followed too many redirects",
        "network",
      );
    }
    const next = new URL(location, url).toString();
    if (!isPublicUrl(next)) {
      throw new SafeFetchError(
        "safeFetch refused a redirect to a private or non-public host",
        "private_host",
      );
    }
    if (res.status === 307 || res.status === 308) {
      if (current.body != null) {
        throw new SafeFetchError(
          "safeFetch cannot repeat a request body across a redirect",
          "network",
        );
      }
    } else {
      const { body: _body, ...rest } = current;
      void _body;
      current = { ...rest, method: "GET" };
    }
    url = next;
  }
}

/**
 * Default-safe outbound fetch wrapper.
 *
 * - `init.redirect` defaults to `"manual"` so a public host that 302s to
 *   `169.254.169.254` (cloud metadata) or an RFC1918 admin panel cannot
 *   coerce the client into leaking the request's `Authorization` header
 *   on the redirected hop. Callers that explicitly set `init.redirect`
 *   keep their choice; callers that pass `opts.followRedirects: true`
 *   get the WHATWG default of `"follow"`.
 * - `init.signal` defaults to `AbortSignal.timeout(15_000)` so a tar-pit
 *   upstream cannot pin a worker indefinitely. Composes with any
 *   caller-owned signal via `AbortSignal.any`.
 * - When `opts.requirePublicHost` is true, runs `isPublicUrl` first and
 *   throws `SafeFetchError({ kind: "private_host" })` on rejection. The
 *   DNS-rebinding hardening (issue #217) extends this flag with a
 *   connect-time IP pin via the pinned dispatcher.
 *
 * This is the documented egress entry point for every outbound call that
 * does NOT target a hard-coded host (Anthropic / OpenAI / Apple /
 * Telegram / Withings / GitHub — constant strings, no rebinding surface
 * by construction). The four hard-coded hosts also route through it for
 * convention consistency.
 */
export async function safeFetch(
  url: string | URL,
  init: RequestInit = {},
  opts: SafeFetchOptions = {},
): Promise<Response> {
  const target = url.toString();
  const operatorApprovedOrigin = opts.operatorApprovedPrivateOrigin;

  if (opts.requirePublicHost && operatorApprovedOrigin !== undefined) {
    throw new SafeFetchError(
      "safeFetch received mutually exclusive destination policies",
      "private_host",
    );
  }

  if (operatorApprovedOrigin !== undefined) {
    let targetOrigin: string;
    let approvedOrigin: string;
    try {
      targetOrigin = new URL(target).origin;
      const approvedUrl = new URL(operatorApprovedOrigin);
      if (
        (approvedUrl.protocol !== "http:" &&
          approvedUrl.protocol !== "https:") ||
        approvedUrl.username ||
        approvedUrl.password ||
        approvedUrl.pathname !== "/" ||
        approvedUrl.search ||
        approvedUrl.hash ||
        operatorApprovedOrigin !== approvedUrl.origin
      ) {
        throw new TypeError("approval must be one canonical http(s) origin");
      }
      approvedOrigin = approvedUrl.origin;
    } catch {
      throw new SafeFetchError(
        "safeFetch received an invalid operator-approved origin",
        "private_host",
      );
    }

    if (targetOrigin !== approvedOrigin) {
      throw new SafeFetchError(
        "safeFetch target does not match the operator-approved origin",
        "private_host",
      );
    }
  } else if (opts.requirePublicHost && !isPublicUrl(target)) {
    throw new SafeFetchError(
      `safeFetch refused private or non-public host: ${target}`,
      "private_host",
    );
  }

  const redirect: RequestRedirect =
    init.redirect ?? (opts.followRedirects ? "follow" : "manual");

  if (operatorApprovedOrigin !== undefined && redirect !== "manual") {
    throw new SafeFetchError(
      "safeFetch forbids redirects for an operator-approved private origin",
      "private_host",
    );
  }

  const signal = composeSignals(
    init.signal ?? opts.signal ?? undefined,
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  // When the caller asks for the public-host guard, also route through
  // the pinned-IP dispatcher so a DNS rebinding cannot flip the host
  // between the input-time `isPublicUrl` accept and the connect call.
  const dispatcher = opts.requirePublicHost
    ? getPinnedPublicDispatcher()
    : operatorApprovedOrigin !== undefined
      ? getPinnedOperatorApprovedDispatcher()
      : undefined;

  const finalInit = {
    ...init,
    redirect,
    signal,
  } as RequestInit;

  try {
    if (dispatcher) {
      // Drive the pinned dispatcher through undici's OWN `fetch`, not the
      // global one. Node's built-in `fetch` is backed by an internal,
      // version-pinned copy of undici; handing it an `Agent` built from
      // the project's `undici@8` throws `UND_ERR_INVALID_ARG` on a
      // dispatch-handler interface mismatch (Node 25 locally; the skew is
      // by construction, not environment luck). Using undici's own fetch
      // locks the dispatcher and the fetch engine to one undici version.
      // The cast bridges undici's RequestInit (which carries `dispatcher`)
      // and its Response back to the DOM types this module exposes.
      if (opts.requirePublicHost && redirect === "follow") {
        return await followCheckingEachHop(target, finalInit, dispatcher);
      }
      const res = await undiciFetch(target, {
        ...finalInit,
        dispatcher,
      } as Parameters<typeof undiciFetch>[1]);
      return res as unknown as Response;
    }
    return await fetch(target, finalInit);
  } catch (err) {
    if (err instanceof SafeFetchError) throw err;
    if (hasPrivateHostPolicyCause(err)) {
      throw new SafeFetchError(
        "safeFetch refused a private resolved destination",
        "private_host",
        err,
      );
    }
    // `AbortSignal.timeout` aborts with `TimeoutError` (`DOMException`
    // named "TimeoutError"); a caller-side abort surfaces as
    // `AbortError`. Both manifest as the same `err.name` check.
    if (err instanceof DOMException) {
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        throw new SafeFetchError(
          `safeFetch aborted (${err.name}): ${target}`,
          "timeout",
          err,
        );
      }
    }
    throw new SafeFetchError(
      `safeFetch network error: ${err instanceof Error ? err.message : String(err)}`,
      "network",
      err,
    );
  }
}

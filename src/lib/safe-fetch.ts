import { isPublicUrl } from "@/lib/validations/notifications";
import { getPinnedPublicDispatcher } from "@/lib/safe-fetch-dispatcher";

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

  if (opts.requirePublicHost && !isPublicUrl(target)) {
    throw new SafeFetchError(
      `safeFetch refused private or non-public host: ${target}`,
      "private_host",
    );
  }

  const redirect: RequestRedirect =
    init.redirect ?? (opts.followRedirects ? "follow" : "manual");

  const signal = composeSignals(
    init.signal ?? opts.signal ?? undefined,
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  // When the caller asks for the public-host guard, also route through
  // the pinned-IP dispatcher so a DNS rebinding cannot flip the host
  // between the input-time `isPublicUrl` accept and the connect call.
  // Node's `fetch` accepts an undici `dispatcher` on RequestInit; the
  // DOM types don't reflect that, so we cast at the boundary.
  const dispatcher = opts.requirePublicHost
    ? getPinnedPublicDispatcher()
    : undefined;
  const finalInit = {
    ...init,
    redirect,
    signal,
    ...(dispatcher ? { dispatcher } : {}),
  } as RequestInit;

  try {
    return await fetch(target, finalInit);
  } catch (err) {
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

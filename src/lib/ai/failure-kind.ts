import { SafeFetchError } from "@/lib/safe-fetch";

/**
 * What one failed provider call actually ran into, in our own closed
 * vocabulary. The chain used to collapse every failure without an HTTP status
 * into "network", so a refused connection, our own deadline, a socket the
 * server closed and a 200 that carried no answer all read the same in the log
 * and in the briefing's empty state (#1267).
 *
 * Read from the thrown value only: the `SafeFetchError` kind, the client's own
 * `kind` tag, and the Node / undici error `code` somewhere down the `cause`
 * chain. Never the message, which can carry a URL.
 */
export type ProviderFailureKind =
  /** Our own deadline (the response-timeout setting or the surface's). */
  | "timeout"
  /** The caller cancelled (the Coach tab closed, a job shut down). */
  | "aborted"
  /** The destination policy refused the host or its resolved address. */
  | "private_host"
  | "dns"
  | "refused"
  | "unreachable"
  | "connect_timeout"
  /** The connection was reset or closed under a request in flight. */
  | "reset"
  | "socket"
  | "headers_timeout"
  | "body_timeout"
  | "tls"
  /** A 2xx body that was not the JSON it claimed to be. */
  | "parse"
  /** A 2xx reply with no answer and no reasoning. */
  | "empty_response"
  /** A 2xx reply that reasoned and never answered. */
  | "reasoning_only"
  /** A stream that broke before its first token. */
  | "stream_aborted"
  /** A 2xx body that carried the gateway's own failure. */
  | "embedded_error"
  /** A non-2xx HTTP status. */
  | "http"
  /**
   * #1279 — not sent: background work waits out a provider the health
   * ledger has benched after failures in a row (`provider-runner.ts`).
   */
  | "paused"
  /** A transport failure with no code this list knows. */
  | "network"
  | "unknown";

export interface ProviderFailure {
  failure: ProviderFailureKind;
  /**
   * The Node / undici error code that decided `failure`, when there is one
   * (`ECONNRESET`, `UND_ERR_SOCKET`). Only strings shaped like a code pass, so
   * nothing free-form reaches a log line.
   */
  code: string | null;
}

const CODE_SHAPE = /^[A-Z][A-Z0-9_]{1,47}$/;

const CODE_KINDS: ReadonlyArray<[RegExp, ProviderFailureKind]> = [
  [/^(ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_FAIL)$/, "dns"],
  [/^ECONNREFUSED$/, "refused"],
  [/^(EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ENETDOWN)$/, "unreachable"],
  [/^(UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT)$/, "connect_timeout"],
  [/^(ECONNRESET|EPIPE|ECONNABORTED)$/, "reset"],
  [/^(UND_ERR_SOCKET|UND_ERR_CLOSED)$/, "socket"],
  [/^UND_ERR_HEADERS_TIMEOUT$/, "headers_timeout"],
  [/^UND_ERR_BODY_TIMEOUT$/, "body_timeout"],
  [
    /^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_|ERR_OSSL_)/,
    "tls",
  ],
];

const CLIENT_KINDS: ReadonlySet<ProviderFailureKind> = new Set([
  "empty_response",
  "reasoning_only",
  "stream_aborted",
  "embedded_error",
]);

/** Every value down the `cause` chain (and an aggregate's `errors`). */
function causeChain(error: unknown): unknown[] {
  const out: unknown[] = [];
  const queue: unknown[] = [error];
  while (queue.length > 0 && out.length < 16) {
    const next = queue.shift();
    if (next === null || typeof next !== "object" || out.includes(next)) {
      continue;
    }
    out.push(next);
    const value = next as { cause?: unknown; errors?: unknown };
    if (value.cause !== undefined) queue.push(value.cause);
    if (Array.isArray(value.errors)) queue.push(...value.errors);
  }
  return out;
}

function firstCode(chain: unknown[]): string | null {
  for (const value of chain) {
    const code = (value as { code?: unknown }).code;
    if (typeof code === "string" && CODE_SHAPE.test(code)) return code;
  }
  return null;
}

function isNamed(value: unknown, name: string): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { name?: unknown }).name === name
  );
}

/** Classify one thrown provider failure. Never throws. */
export function providerFailureKind(error: unknown): ProviderFailure {
  try {
    const chain = causeChain(error);
    const code = firstCode(chain);
    const head = (error ?? {}) as { kind?: unknown; httpStatus?: unknown };

    if (typeof head.kind === "string" && CLIENT_KINDS.has(head.kind as never)) {
      return { failure: head.kind as ProviderFailureKind, code };
    }
    if (typeof head.httpStatus === "number" && head.httpStatus > 0) {
      return { failure: "http", code: null };
    }
    if (error instanceof SafeFetchError && error.kind === "private_host") {
      return { failure: "private_host", code: null };
    }
    // Our deadline aborts with `TimeoutError`, a caller with `AbortError`;
    // `safeFetch` wraps both, a body read after the headers does not.
    if (chain.some((v) => isNamed(v, "TimeoutError"))) {
      return { failure: "timeout", code: null };
    }
    if (chain.some((v) => isNamed(v, "AbortError"))) {
      return { failure: "aborted", code: null };
    }
    if (code) {
      for (const [pattern, kind] of CODE_KINDS) {
        if (pattern.test(code)) return { failure: kind, code };
      }
    }
    if (chain.some((v) => v instanceof SyntaxError)) {
      return { failure: "parse", code };
    }
    if (error instanceof SafeFetchError || code !== null) {
      return { failure: "network", code };
    }
    if (chain.some((v) => v instanceof TypeError)) {
      return { failure: "network", code };
    }
    return { failure: "unknown", code };
  } catch {
    return { failure: "unknown", code: null };
  }
}

/** True for the kinds that mean a deadline ran out. */
export function isTimeoutFailure(kind: ProviderFailureKind | null): boolean {
  return (
    kind === "timeout" ||
    kind === "connect_timeout" ||
    kind === "headers_timeout" ||
    kind === "body_timeout"
  );
}

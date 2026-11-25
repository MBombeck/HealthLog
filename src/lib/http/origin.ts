/**
 * The origin a request was made to, and how sure the server is of its scheme.
 *
 * One resolver for every place that asks "was this page served over HTTPS?"
 * or builds an absolute link from the request: the clinician share links,
 * the calendar and care feeds, the emergency card, the setup check and the
 * sign-in's transport log line.
 *
 * The scheme, in order:
 *
 *   1. What a trusted proxy reported: `X-Forwarded-Proto`, the `proto=` of
 *      an RFC 7239 `Forwarded` header, or `X-Forwarded-Ssl: on`. Trusted
 *      means the connection's peer may forward (`peerMayForward`, the rule
 *      the client-IP resolver uses, set by `TRUSTED_PROXY_CIDRS`).
 *   2. The configured public URL (`NEXT_PUBLIC_APP_URL`, else `APP_URL`),
 *      when it names the host the request was made to. Apache's `ProxyPass`
 *      sends `X-Forwarded-Host` but no `X-Forwarded-Proto` unless told to,
 *      so an HTTPS site behind it used to read as plain HTTP.
 *   3. The request URL's own scheme.
 *
 * Next fills `X-Forwarded-Proto` with `http` on every request that lacks it,
 * so step 1 reads the value the request arrived with, kept by the peer stamp
 * (`FORWARDED_PROTO_SENT_HEADER`), not the header Next rewrote.
 *
 * The host is `X-Forwarded-Host` (or `Forwarded`'s `host=`) from a trusted
 * proxy, else `Host`, else the request URL's host. It only ever reaches the
 * caller who sent it, in the response to their own authenticated request.
 */
import {
  FORWARDED_PROTO_SENT_HEADER,
  peerAddressStampInstalled,
  readPeerAddress,
} from "./peer-address";
import { peerMayForward } from "./proxy-trust";

type Scheme = "http" | "https";

export interface RequestOrigin {
  origin: string;
  protocol: Scheme;
  host: string;
  /**
   * Where the scheme came from: a trusted proxy's report, the configured
   * public URL, or the request URL itself. `public_url` means the proxy in
   * front did not say, so the scheme rests on the operator's configuration.
   */
  protocolFrom: "proxy" | "public_url" | "request";
}

interface RequestLike {
  headers: Headers;
  url: string;
}

/** Whether this connection may report forwarding headers at all. */
function forwardingTrusted(request: RequestLike): boolean {
  const peer = readPeerAddress(request);
  if (peer === null) return false;
  // No stamp: a request the server did not receive (a suite's hand-built
  // one), unless the stamp is installed, when nothing vouches for it.
  if (peer === undefined) return !peerAddressStampInstalled();
  return peerMayForward(peer);
}

function firstEntry(value: string | null | undefined): string | undefined {
  const first = value?.split(",")[0]?.trim();
  return first ? first : undefined;
}

function asScheme(value: string | undefined): Scheme | undefined {
  const lower = value?.toLowerCase();
  return lower === "https" || lower === "http" ? lower : undefined;
}

/** `proto=` and `host=` of the first element of an RFC 7239 `Forwarded`. */
function readForwarded(value: string | null): {
  proto?: string;
  host?: string;
} {
  let proto: string | undefined;
  let host: string | undefined;
  for (const pair of (firstEntry(value) ?? "").split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim().toLowerCase();
    const raw = pair
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1");
    if (key === "proto") proto = raw;
    else if (key === "host") host = raw;
  }
  return { proto, host };
}

/** The `X-Forwarded-Proto` the request arrived with, before Next filled it. */
function sentForwardedProto(request: RequestLike): string | undefined {
  if (peerAddressStampInstalled()) {
    return firstEntry(request.headers.get(FORWARDED_PROTO_SENT_HEADER));
  }
  return firstEntry(request.headers.get("x-forwarded-proto"));
}

function configuredPublicUrl(
  env: Record<string, string | undefined>,
): URL | null {
  const raw =
    (env.NEXT_PUBLIC_APP_URL ?? "").trim() || (env.APP_URL ?? "").trim();
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function resolveRequestOrigin(
  request: RequestLike,
  env: Record<string, string | undefined> = process.env,
): RequestOrigin {
  const url = new URL(request.url);
  const trusted = forwardingTrusted(request);
  const forwarded = trusted
    ? readForwarded(request.headers.get("forwarded"))
    : {};

  const host =
    (trusted
      ? (firstEntry(request.headers.get("x-forwarded-host")) ?? forwarded.host)
      : undefined) ??
    request.headers.get("host") ??
    url.host;

  const build = (
    protocol: Scheme,
    protocolFrom: RequestOrigin["protocolFrom"],
  ): RequestOrigin => ({
    origin: `${protocol}://${host}`,
    protocol,
    host,
    protocolFrom,
  });

  if (trusted) {
    const reported =
      asScheme(sentForwardedProto(request)) ??
      asScheme(forwarded.proto) ??
      (request.headers.get("x-forwarded-ssl")?.trim().toLowerCase() === "on"
        ? "https"
        : undefined);
    if (reported) return build(reported, "proxy");
  }

  const publicUrl = configuredPublicUrl(env);
  const publicScheme = asScheme(publicUrl?.protocol.replace(":", ""));
  if (publicUrl && publicScheme && publicUrl.host === host.toLowerCase()) {
    return build(publicScheme, "public_url");
  }

  return build(url.protocol === "https:" ? "https" : "http", "request");
}

/** The absolute origin a link the app hands out is built from. */
export function resolveOrigin(request: Request): string {
  return resolveRequestOrigin(request).origin;
}

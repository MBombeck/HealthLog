/**
 * The address a request's TCP connection came from, as a header the route
 * handlers can read.
 *
 * Next does not hand a route the socket. It does fill `X-Forwarded-For` with
 * the socket's address, but only when the request carries none, so a caller
 * that reaches the server directly and sends its own `X-Forwarded-For`
 * chooses the address every per-IP limit, the audit log and the sign-in
 * notices see. To tell a forwarded request from a forged one, the client-IP
 * resolver (`getClientIpOrTrustWarning` in `@/lib/api-response`) needs the
 * connection's own peer, and this provides it.
 *
 * `installPeerAddressStamp` subscribes to Node's `http.server.request.start`
 * diagnostics channel, which fires for every request before the server's
 * request handler runs, and writes the socket's remote address into
 * `PEER_ADDRESS_HEADER`, overwriting whatever the caller sent under that
 * name. It is installed once, at boot, from `src/instrumentation.ts`.
 */
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type { Socket } from "node:net";

/** The header the socket's address is written to. Never trusted from a caller. */
export const PEER_ADDRESS_HEADER = "x-healthlog-peer-address";

const INSTALLED = Symbol.for("healthlog.peerAddressStamp");

type StampGlobal = typeof globalThis & { [INSTALLED]?: boolean };

const CHANNEL = "http.server.request.start";

function stamp(message: unknown): void {
  const { request, socket } = message as {
    request: IncomingMessage;
    socket: Socket;
  };
  request.headers[PEER_ADDRESS_HEADER] = socket.remoteAddress ?? "";
}

/** Start writing each request's socket address into `PEER_ADDRESS_HEADER`. */
export function installPeerAddressStamp(): void {
  const g = globalThis as StampGlobal;
  if (g[INSTALLED]) return;
  subscribe(CHANNEL, stamp);
  g[INSTALLED] = true;
}

/** Test hook: a suite that installs the stamp takes it out again. */
export function __uninstallPeerAddressStampForTests(): void {
  unsubscribe(CHANNEL, stamp);
  (globalThis as StampGlobal)[INSTALLED] = false;
}

/** Whether this process stamps requests (it does once booted). */
export function peerAddressStampInstalled(): boolean {
  return (globalThis as StampGlobal)[INSTALLED] === true;
}

/**
 * The connection's peer, normalised (an IPv4-mapped IPv6 address reads as
 * IPv4). `undefined` when the request carries no stamp, `null` when it
 * carries one that is not an address (a socket already gone).
 */
export function readPeerAddress(request: Request): string | null | undefined {
  const raw = request.headers.get(PEER_ADDRESS_HEADER);
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  const address = mapped ? mapped[1]! : trimmed;
  return isIP(address) !== 0 ? address : null;
}

/**
 * Which connections may tell the server who the client is.
 *
 * A reverse proxy reports the client's address in `X-Forwarded-For` or
 * `X-Real-IP`. Anyone else who sends those headers is choosing the address
 * every per-IP rate limit, the audit log and the sign-in notices see, so the
 * client-IP resolver (`getClientIpOrTrustWarning` in `@/lib/api-response`)
 * reads them only from a peer this module says may forward.
 *
 * Two rules:
 *
 *   - `TRUSTED_PROXY_CIDRS` set (comma-separated CIDRs, IPv4 or IPv6): only
 *     a peer inside one of them may forward. Every other connection is its
 *     own client, whatever address it comes from.
 *   - unset: any peer whose address is not public (loopback, private,
 *     CGNAT, unique-local, link-local) may forward. This is the long-standing
 *     default and stays for compatibility, but it is only as good as the
 *     network: behind Docker Desktop, OrbStack or `docker-proxy` every
 *     connection to a published port arrives from the gateway address, a
 *     private one, so a caller that reaches the port directly is believed
 *     again. Setting the list closes that.
 *
 * `TRUST_PROXY_HOPS` says how many proxies the `X-Forwarded-For` chain
 * passed through. A value that is not a non-negative integer used to throw
 * on every request that asked for the client address, `/api/health`
 * included; it now resolves no address and is named once at boot.
 *
 * Both are read per call, so the suites can change them; the parsed CIDR
 * list is cached by its raw value.
 */
import { BlockList, isIP } from "node:net";

import { isPublicIp } from "@/lib/validations/notifications";

// ── TRUST_PROXY_HOPS ──────────────────────────────────────────────────────

/**
 * The configured hop count, `1` when unset or empty, or `null` when the
 * value is not a non-negative integer.
 */
export function parseTrustProxyHops(raw: string | undefined): number | null {
  // Empty is unset. The shipped docker-compose.yml passes
  // `TRUST_PROXY_HOPS: "${TRUST_PROXY_HOPS:-}"`, which is an empty string for
  // every operator who never set it.
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return 1;
  if (!/^\d+$/.test(trimmed)) return null;
  return parseInt(trimmed, 10);
}

// ── TRUSTED_PROXY_CIDRS ───────────────────────────────────────────────────

export type TrustedProxyList =
  /** Unset: the private-address default applies. */
  | { kind: "unset" }
  | { kind: "list"; entries: string[]; blockList: BlockList }
  /** Set, but an entry is not a CIDR. No peer may forward. */
  | { kind: "invalid"; invalid: string[] };

/** `10.0.0.0/8`, `127.0.0.1`, `fd00::/8`; a bare address is a /32 or /128. */
function parseCidr(
  entry: string,
): { address: string; prefix: number; family: "ipv4" | "ipv6" } | null {
  const [address = "", prefixText, extra] = entry.split("/");
  if (extra !== undefined) return null;
  const version = isIP(address);
  if (version === 0) return null;
  const max = version === 4 ? 32 : 128;
  if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  if (prefix > max) return null;
  return { address, prefix, family: version === 4 ? "ipv4" : "ipv6" };
}

let cached: { raw: string; list: TrustedProxyList } | null = null;

export function parseTrustedProxyCidrs(
  raw: string | undefined,
): TrustedProxyList {
  const value = raw?.trim() ?? "";
  if (cached && cached.raw === value) return cached.list;
  let list: TrustedProxyList;
  if (value === "") {
    list = { kind: "unset" };
  } else {
    const entries = value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const blockList = new BlockList();
    const invalid: string[] = [];
    for (const entry of entries) {
      const cidr = parseCidr(entry);
      if (!cidr) {
        invalid.push(entry);
        continue;
      }
      blockList.addSubnet(cidr.address, cidr.prefix, cidr.family);
    }
    list =
      invalid.length > 0 || entries.length === 0
        ? { kind: "invalid", invalid: invalid.length > 0 ? invalid : [value] }
        : { kind: "list", entries, blockList };
  }
  cached = { raw: value, list };
  return list;
}

/** Whether a connection from `peer` may report the client's address. */
export function peerMayForward(peer: string): boolean {
  const list = parseTrustedProxyCidrs(process.env.TRUSTED_PROXY_CIDRS);
  if (list.kind === "unset") return !isPublicIp(peer);
  if (list.kind === "invalid") return false;
  const family = isIP(peer) === 6 ? "ipv6" : "ipv4";
  return list.blockList.check(peer, family);
}

// ── The boot line ─────────────────────────────────────────────────────────

/**
 * One line naming the rule in force, for the boot log: which peers may
 * forward, how many hops are read, and what is wrong with a value that
 * cannot be used.
 */
export function describeProxyTrust(): {
  level: "info" | "error";
  message: string;
} {
  const hopsRaw = process.env.TRUST_PROXY_HOPS;
  const hops = parseTrustProxyHops(hopsRaw);
  const list = parseTrustedProxyCidrs(process.env.TRUSTED_PROXY_CIDRS);
  const problems: string[] = [];
  if (hops === null) {
    problems.push(
      `TRUST_PROXY_HOPS=${JSON.stringify(hopsRaw)} is not a non-negative integer, so no client address is read from forwarding headers`,
    );
  }
  if (list.kind === "invalid") {
    problems.push(
      `TRUSTED_PROXY_CIDRS has entries that are not CIDRs (${list.invalid.map((e) => JSON.stringify(e)).join(", ")}), so no connection may report a client address`,
    );
  }
  const peers =
    list.kind === "list"
      ? `only connections from ${list.entries.join(", ")} (TRUSTED_PROXY_CIDRS)`
      : list.kind === "unset"
        ? "connections from any loopback, private, CGNAT, unique-local or link-local address (TRUSTED_PROXY_CIDRS unset; behind Docker Desktop, OrbStack or docker-proxy that includes every caller of a published port)"
        : "no connection";
  if (problems.length > 0) {
    return {
      level: "error",
      message: `[proxy-trust] ${problems.join("; ")}. Fix the value; see docs/self-hosting/reverse-proxy.md.`,
    };
  }
  return {
    level: "info",
    message:
      hops === 0
        ? "[proxy-trust] TRUST_PROXY_HOPS=0: forwarding headers are never read; the client address is the connection's own."
        : `[proxy-trust] forwarding headers are read from ${peers}, ${hops} hop${hops === 1 ? "" : "s"} deep (TRUST_PROXY_HOPS).`,
  };
}

/**
 * Log the rule in force once, at boot (`src/instrumentation.ts`). The
 * logger is a parameter, as in the readiness summary: the production build
 * strips direct `console.log` calls.
 */
export function logProxyTrustAtBoot(
  log: Pick<Console, "log" | "error"> = console,
): void {
  const { level, message } = describeProxyTrust();
  if (level === "error") log.error(message);
  else log.log(message);
}

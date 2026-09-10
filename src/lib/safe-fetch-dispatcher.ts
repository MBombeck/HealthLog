import dns from "node:dns";
import { Agent } from "undici";
import {
  isOperatorGrantableIp,
  isPublicIp,
} from "@/lib/validations/notifications";

/**
 * Custom `undici.Agent` that resolves the request hostname literally,
 * vets every returned address against `isPublicIp`, and pins the
 * connection to the vetted survivor set.
 *
 * This closes the DNS-rebinding gap that `isPublicUrl` cannot reach
 * (issue #217). The input-time check accepts a hostname that resolves
 * to a public address; the resolver is then free to flip the record to
 * `169.254.169.254` (cloud metadata) or `10.0.0.x` (operator admin
 * panel) by the time the connection dials. With a TTL of 0 the attack
 * is reliable.
 *
 * Mechanism:
 *
 *  1. Override `connect.lookup` with a wrapper that always runs
 *     `dns.lookup({ all: true })` so we see every address the resolver
 *     would have returned.
 *  2. Filter that list through `isPublicIp` — same allowlist
 *     `isPublicUrl` enforces, applied to a literal IP address rather
 *     than the input string.
 *  3. Hand undici the FULL vetted survivor set, not just the first
 *     address. The `Agent` runs with `autoSelectFamily`, so undici's
 *     connector calls this lookup with `all: true` and then performs
 *     RFC 8305 Happy Eyeballs across the survivors. Returning only the
 *     first address — historically `allowed[0]` — defeated that: a host
 *     whose first record is an unreachable IPv6 (common on a no-IPv6
 *     container / LAN / Tailscale path, e.g. `claude.ai` from a v4-only
 *     box) failed the connect instantly even though a working IPv4
 *     record was right behind it. Every IP undici may dial was vetted in
 *     THIS lookup, so DNS rebinding stays closed while v4/v6 fallback
 *     works.
 *  4. If no address passes, fail closed with `dns.NOTFOUND` so the
 *     dispatch surfaces as a normal connect error rather than a silent
 *     bypass.
 *
 * Wired into `safeFetch` only when `opts.requirePublicHost` is true.
 * The outbound paths that accept a user-supplied host all use that flag.
 */
type AddressPolicy = "public" | "operator-approved";

function pinnedLookupWithPolicy(
  policy: AddressPolicy,
  hostname: string,
  options: dns.LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number,
  ) => void,
): void {
  // Always ask for every address so the filter sees the full set;
  // discarding alternates a low-TTL attacker could swap in is exactly
  // the point of the pin.
  const opts: dns.LookupAllOptions = {
    family: options.family ?? 0,
    hints: options.hints,
    verbatim: options.verbatim,
    all: true,
  };

  dns.lookup(hostname, opts, (err, addresses) => {
    if (err) {
      callback(err, "");
      return;
    }
    // The operator-approved policy is not "anything that parses": a listed
    // name that resolves to loopback, link-local or the metadata range is
    // refused here exactly as an unlisted one would be. The grant opens the
    // operator's own network, never the container or the cloud host.
    const allowed = addresses.filter((address) =>
      policy === "public"
        ? isPublicIp(address.address)
        : isOperatorGrantableIp(address.address),
    );
    if (allowed.length === 0) {
      const refused = new Error(
        `safeFetch refused private resolved address for ${hostname}`,
      ) as NodeJS.ErrnoException & { safeFetchKind: "private_host" };
      refused.code = "ENOTFOUND";
      // Undici wraps connector errors below `TypeError("fetch failed")`.
      // Preserve an explicit machine-readable marker so SafeFetch can
      // distinguish a policy refusal from an ordinary NXDOMAIN result and
      // return the redacted `private_host` classification to its caller.
      refused.safeFetchKind = "private_host";
      // Preserve the result shape Undici requested. Auto-select-family asks
      // for `all: true`; handing that path a scalar empty string can mask the
      // policy error behind an invalid-address error for IPv6 answers.
      callback(refused, options.all ? [] : "");
      return;
    }

    if (options.all) {
      // Caller asked for the array shape — pass through EVERY survivor so
      // undici's Happy-Eyeballs loop can fall back across families. With
      // `autoSelectFamily` enabled (below) the connector always takes
      // this branch.
      callback(null, allowed);
      return;
    }
    // Single-address contract (no `autoSelectFamily`, or a caller that
    // explicitly asked for one address): hand back the first survivor.
    const picked = allowed[0];
    callback(null, picked.address, picked.family);
  });
}

function pinnedPublicLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number,
  ) => void,
): void {
  pinnedLookupWithPolicy("public", hostname, options, callback);
}

function pinnedOperatorApprovedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number,
  ) => void,
): void {
  pinnedLookupWithPolicy("operator-approved", hostname, options, callback);
}

/**
 * Lazily-instantiated singleton. `undici.Agent` keeps an internal pool
 * per origin, so reusing one instance across calls preserves the keep-
 * alive benefit while still pinning each new connection through the
 * vetted lookup.
 */
let cachedPublic: Agent | null = null;
let cachedOperatorApproved: Agent | null = null;

function createPinnedDispatcher(policy: AddressPolicy): Agent {
  return new Agent({
    connect: {
      lookup:
        policy === "public" ? pinnedPublicLookup : pinnedOperatorApprovedLookup,
      // RFC 8305 Happy Eyeballs across the vetted survivor set. Without
      // this undici pins the single first address and dies when that is
      // an unreachable IPv6 record on a v4-only host. With it, undici
      // calls `pinnedLookup` with `all: true` and races the vetted v4/v6
      // candidates, taking the first that connects.
      autoSelectFamily: true,
      // How long to wait for one family before trying the next. 250 ms is
      // the documented sane default — long enough not to thrash on a slow
      // RTT, short enough that a black-holed family falls back quickly.
      autoSelectFamilyAttemptTimeout: 250,
    },
  });
}

export function getPinnedPublicDispatcher(): Agent {
  cachedPublic ??= createPinnedDispatcher("public");
  return cachedPublic;
}

/**
 * Pinned dispatcher for an exact operator-approved origin.
 *
 * Private addresses are permitted only after an exact-origin policy
 * (`NIGHTSCOUT_PRIVATE_ORIGINS`, `NOTIFICATION_PRIVATE_ORIGINS`) has matched
 * the complete canonical scheme/host/port trust grant. Resolution is still
 * performed once inside Undici's connector and the vetted answer set is
 * pinned to the socket, so a later DNS answer cannot replace the destination.
 * Loopback, unspecified, link-local and metadata answers are dropped
 * regardless of the grant (`isOperatorGrantableIp`).
 */
export function getPinnedOperatorApprovedDispatcher(): Agent {
  cachedOperatorApproved ??= createPinnedDispatcher("operator-approved");
  return cachedOperatorApproved;
}

/**
 * Test helper. The dispatcher is module-state; tests that mock
 * `dns.lookup` need to clear the cached instance so the next call
 * binds the mock.
 */
export function _resetPinnedDispatcherForTests(): void {
  cachedPublic?.destroy().catch(() => {});
  cachedOperatorApproved?.destroy().catch(() => {});
  cachedPublic = null;
  cachedOperatorApproved = null;
}

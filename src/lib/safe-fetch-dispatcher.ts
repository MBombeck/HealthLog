import dns from "node:dns";
import { Agent } from "undici";
import { isPublicIp } from "@/lib/validations/notifications";

/**
 * Custom `undici.Agent` that resolves the request hostname literally,
 * vets every returned address against `isPublicIp`, and pins the
 * connection to the first allowed address.
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
 *  3. If at least one address passes, hand the single first survivor
 *     to undici. Undici then pins the TCP connect to that exact IP,
 *     side-stepping any further resolver hop.
 *  4. If no address passes, fail closed with `dns.NOTFOUND` so the
 *     dispatch surfaces as a normal connect error rather than a silent
 *     bypass.
 *
 * Wired into `safeFetch` only when `opts.requirePublicHost` is true.
 * The five outbound paths that accept a user-supplied host all use
 * that flag.
 */
function pinnedLookup(
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
    const allowed = addresses.filter((a) => isPublicIp(a.address));
    if (allowed.length === 0) {
      const refused: NodeJS.ErrnoException = new Error(
        `safeFetch refused private resolved address for ${hostname}`,
      );
      refused.code = "ENOTFOUND";
      callback(refused, "");
      return;
    }

    const picked = allowed[0];
    if (options.all) {
      // Caller asked for the array shape — pass through the survivors.
      callback(null, allowed);
      return;
    }
    callback(null, picked.address, picked.family);
  });
}

/**
 * Lazily-instantiated singleton. `undici.Agent` keeps an internal pool
 * per origin, so reusing one instance across calls preserves the keep-
 * alive benefit while still pinning each new connection through the
 * vetted lookup.
 */
let cached: Agent | null = null;

export function getPinnedPublicDispatcher(): Agent {
  if (cached) return cached;
  cached = new Agent({
    connect: {
      lookup: pinnedLookup,
    },
  });
  return cached;
}

/**
 * Test helper. The dispatcher is module-state; tests that mock
 * `dns.lookup` need to clear the cached instance so the next call
 * binds the mock.
 */
export function _resetPinnedDispatcherForTests(): void {
  cached?.destroy().catch(() => {});
  cached = null;
}

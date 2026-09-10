/**
 * v1.11.2 — SSRF DNS-rebinding pin inventory.
 *
 * Source-text guard (same approach as the queue-registration + coach-gate
 * inventory tests): the outbound `safeFetch` sites whose host is user- or
 * operator-controlled MUST pass `requirePublicHost: true`, which wires both
 * the input-time `isPublicUrl` check and the connect-time DNS-rebinding pin.
 * A future edit that drops the pin (re-opening the SSRF surface) fails here
 * instead of shipping silently.
 *
 * The LOCAL AI client and (since v1.37.30) the openai-client's gateway and
 * admin-key tags are the deliberate exceptions: they stay CONDITIONAL
 * (`requirePublicHost: !allowPrivate`) so an operator can opt into LAN hosts
 * via `ALLOW_LOCAL_AI_PRIVATE_HOSTS`. v1.18.7 (SECURITY LOW) — that flag is
 * now a host ALLOWLIST (`true` = any private host; a comma-separated list =
 * only those), resolved by `isLocalAiHostAllowed`. We assert the client keeps
 * the conditional shape AND derives `allowPrivate` from the allowlist helper
 * (not a raw `=== "true"` binary), never an unconditional `true` (which would
 * break LAN local models) and never absent (which would re-open the default).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("SSRF requirePublicHost pin inventory", () => {
  // v1.37.30 — openai-client is no longer a blanket pin: the gateway and
  // admin-key tags carry a person-typed base URL and route through the
  // operator allowlist helper, with `true` as the ternary floor for every
  // other tag (codex). We assert the exact conditional shape so a future
  // edit can neither drop the floor nor widen the condition silently.
  it("openai-client routes person-typed base URLs through the allowlist with a pinned floor", () => {
    const src = read("ai/openai-client.ts");
    expect(src).toMatch(
      /requirePublicHost:\s*this\.isGateway \|\| this\.type === "admin-key"\s*\? requirePublicHostFor\(this\.config\.baseUrl\)\s*:\s*true/,
    );
  });

  it("anthropic-client pins the BYO base-URL outbound unconditionally", () => {
    expect(read("ai/anthropic-client.ts")).toMatch(/requirePublicHost:\s*true/);
  });

  it("geo lookup pins the operator IP_GEO_LOOKUP_URL outbound", () => {
    expect(read("geo.ts")).toMatch(/requirePublicHost:\s*true/);
  });

  it("Nightscout routes exact operator-approved private origins through the private pin", () => {
    const src = read("nightscout/client.ts");
    expect(src).toMatch(
      /operatorApprovedPrivateOrigin:\s*policy\.canonicalOrigin/,
    );
    expect(src).toMatch(/requirePublicHost:\s*!policy\.privateOriginApproved/);
    expect(src).not.toMatch(
      /operatorApprovedPrivateOrigin:\s*opts\.allowPrivateHost/,
    );
  });

  // v1.11.2 locked the ntfy pin as an unconditional `true`. Since #947 both
  // user-supplied notification targets carry the same conditional shape as
  // Nightscout: the public pin unless the operator listed the exact origin
  // in NOTIFICATION_PRIVATE_ORIGINS, in which case the operator-approved pin
  // takes over. Neither a bare `true` (the grant would be dead) nor a bare
  // `false` (the pin would be gone) may reappear.
  it.each([
    ["webhook", "notifications/senders/webhook.ts"],
    ["ntfy", "notifications/senders/ntfy.ts"],
  ])(
    "%s sender routes an exact operator-approved private origin through the private pin",
    (_channel, rel) => {
      const src = read(rel);
      expect(src).toMatch(
        /requirePublicHost:\s*!policy\.privateOriginApproved/,
      );
      expect(src).toMatch(
        /operatorApprovedPrivateOrigin:\s*policy\.canonicalOrigin/,
      );
      expect(src).not.toMatch(/requirePublicHost:\s*(?:true|false)\b/);
      // The verdict must come from the shared policy, never a local check.
      expect(src).toMatch(/evaluateNotificationTarget\(/);
    },
  );

  it("local AI client keeps the pin CONDITIONAL (LAN escape hatch)", () => {
    const src = read("ai/local-client.ts");
    // Must carry the conditional form …
    expect(src).toMatch(/requirePublicHost:\s*!?\s*allowPrivate/);
    // … and must NOT be hardened to an unconditional true (that would break
    // a deliberately-private LAN local model).
    expect(src).not.toMatch(/requirePublicHost:\s*true/);
    // … and `allowPrivate` must come from the host-allowlist helper, not a
    // raw binary `=== "true"` (v1.18.7 — the flag became an allowlist).
    expect(src).toMatch(/allowPrivate\s*=\s*isLocalAiHostAllowed\(/);
    expect(src).not.toMatch(/ALLOW_LOCAL_AI_PRIVATE_HOSTS\s*===\s*"true"/);
  });
});

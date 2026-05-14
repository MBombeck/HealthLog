import { describe, it, expect } from "vitest";
import { Cpu, Fingerprint, Globe, KeyRound } from "lucide-react";
import { iconForAuthProvider, providerForAction } from "../_shared";

/**
 * v1.4.25 W8b — Provider column for the admin Login-Übersicht.
 *
 * The audit-log entries don't carry a dedicated "provider" field — the
 * action name itself is the source of truth. These tests pin the
 * coarse mapping that drives the Provider column (and any later
 * surface that reuses `useAuthProviderLabels`). New `auth.*` actions
 * that land in the audit log must be wired into `providerForAction`
 * with a corresponding regression case here.
 */

describe("providerForAction", () => {
  it("classifies passkey actions as `passkey`", () => {
    expect(providerForAction("auth.login.passkey")).toBe("passkey");
    expect(providerForAction("auth.passkey.register")).toBe("passkey");
    expect(providerForAction("auth.passkey.delete")).toBe("passkey");
  });

  it("classifies password actions and failed sign-ins as `password`", () => {
    expect(providerForAction("auth.login.password")).toBe("password");
    expect(providerForAction("auth.password.change")).toBe("password");
    // Failed logins flow through the password endpoint; treating them
    // as `password` is the truthful summary of how the credential was
    // offered. A failed passkey attempt has its own audit row.
    expect(providerForAction("auth.login.failed")).toBe("password");
  });

  it("classifies bearer + native-token actions as `api_token`", () => {
    expect(providerForAction("auth.bearer.success")).toBe("api_token");
    expect(providerForAction("auth.bearer.failure")).toBe("api_token");
    expect(providerForAction("auth.token.autoissue.native")).toBe("api_token");
    expect(providerForAction("auth.token.refresh")).toBe("api_token");
    expect(providerForAction("auth.token.refresh.failed")).toBe("api_token");
    expect(providerForAction("auth.token.refresh.revoke")).toBe("api_token");
    expect(providerForAction("auth.token.revoke")).toBe("api_token");
  });

  it("classifies Withings OAuth events as `withings`", () => {
    expect(providerForAction("auth.withings.connect")).toBe("withings");
    expect(providerForAction("auth.withings.disconnect")).toBe("withings");
  });

  it("falls back to `unknown` for unmapped or generic auth actions", () => {
    expect(providerForAction("auth.login")).toBe("unknown");
    expect(providerForAction("auth.logout")).toBe("unknown");
    expect(providerForAction("auth.register")).toBe("unknown");
    expect(providerForAction("admin.user.delete")).toBe("unknown");
    expect(providerForAction("")).toBe("unknown");
  });
});

describe("iconForAuthProvider", () => {
  it("maps each provider to the documented lucide glyph", () => {
    // Marc's brief pinned the exact icon for each provider so the
    // visual language stays consistent across the admin surface.
    expect(iconForAuthProvider("password")).toBe(KeyRound);
    expect(iconForAuthProvider("passkey")).toBe(Fingerprint);
    expect(iconForAuthProvider("api_token")).toBe(Cpu);
    expect(iconForAuthProvider("withings")).toBe(Globe);
    // `unknown` reuses the OAuth glyph rather than a `?` so the
    // column never paints a missing icon.
    expect(iconForAuthProvider("unknown")).toBe(Globe);
  });
});

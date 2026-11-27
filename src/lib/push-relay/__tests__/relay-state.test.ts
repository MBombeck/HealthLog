import { describe, expect, it } from "vitest";

import type { RegistrationRow } from "@/lib/push-relay/registration";
import {
  CONFLICT_SETTLE_MS,
  relayRefusal,
  relayRoutes,
  relayStateAt,
  type RelayPurpose,
} from "@/lib/push-relay/relay-state";

const now = new Date("2026-11-22T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("relayStateAt", () => {
  it("keeps a fresh conflict for the challenge's 30 minutes", () => {
    expect(
      relayStateAt(
        {
          relayState: "conflict",
          relayConflictAt: ago(CONFLICT_SETTLE_MS - 1),
        },
        now,
      ),
    ).toBe("conflict");
  });

  it("asks for a rebind once the conflict is 30 minutes old", () => {
    expect(
      relayStateAt(
        { relayState: "conflict", relayConflictAt: ago(CONFLICT_SETTLE_MS) },
        now,
      ),
    ).toBe("rebind_needed");
    // A conflict without its time is no fresh one.
    expect(
      relayStateAt({ relayState: "conflict", relayConflictAt: null }, now),
    ).toBe("rebind_needed");
  });

  it("leaves every other state as stored", () => {
    for (const relayState of ["none", "bound", "rebind_needed"]) {
      expect(
        relayStateAt({ relayState, relayConflictAt: ago(3600_000) }, now),
      ).toBe(relayState);
    }
  });
});

describe("relayRefusal", () => {
  const now = new Date("2026-11-27T12:00:00.000Z");
  const later = new Date(now.getTime() + 60_000);
  const wallet = {
    sign: true,
    passTypeIdentifier: "pass.dev.healthlog.vector",
    teamIdentifier: "VECTOR1234",
  };
  const signs = { at: now.toISOString(), state: "ok", wallet };
  const row = (extra: Partial<RegistrationRow> = {}) =>
    ({
      instanceId: "inst",
      state: "ok",
      circuitFailures: 0,
      circuitOpenedAt: null,
      nextProbeAt: null,
      pausedUntil: null,
      relayStatus: signs,
      ...extra,
    }) as RegistrationRow;
  const purposes: RelayPurpose[] = [
    "push",
    "wallet_sign",
    "wallet_notify",
    "upkeep",
  ];
  const refusals = (r: RegistrationRow | null) =>
    purposes.map((p) => relayRefusal(r, p, now));

  it.each([
    ["usable", row(), [null, null, null, null]],
    ["off", null, Array(4).fill("not_registered")],
    [
      "not registered",
      row({ instanceId: null }),
      Array(4).fill("not_registered"),
    ],
    ["revoked", row({ state: "revoked" }), Array(4).fill("ended")],
    [
      "suspended: only upkeep asks",
      row({ state: "suspended" }),
      ["suspended", "suspended", "suspended", null],
    ],
    [
      "degraded after a 429: Wallet does not wait for pushes",
      row({ state: "degraded", pausedUntil: later }),
      ["paused", null, null, "paused"],
    ],
    [
      "breaker open",
      row({ state: "down", circuitOpenedAt: now }),
      ["circuit_open", null, null, "circuit_open"],
    ],
    [
      "the relay does not sign passes",
      row({ relayStatus: { ...signs, wallet: { ...wallet, sign: false } } }),
      [null, "no_wallet_signing", null, null],
    ],
    [
      "no status yet",
      row({ relayStatus: null }),
      [null, "no_wallet_signing", null, null],
    ],
  ] as const)("%s", (_label, r, expected) => {
    expect(refusals(r)).toEqual(expected);
  });

  it("routes a push over the relay while it holds, never once it ended", () => {
    expect(relayRoutes(row({ circuitOpenedAt: now }))).toBe(true);
    expect(relayRoutes(row({ state: "suspended" }))).toBe(true);
    expect(relayRoutes(row({ state: "revoked" }))).toBe(false);
    expect(relayRoutes(row({ instanceId: null }))).toBe(false);
    expect(relayRoutes(null)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  anyItemAccepted,
  RELAY_REPORTED_REASONS,
  relayStatusOf,
  stateForReported,
  STATUS_INTERVAL_MS,
  storedRelayStatus,
} from "@/lib/push-relay/relay-status";
import { statusCheckDue } from "@/lib/push-relay/relay-state";
import type { RegistrationRow } from "@/lib/push-relay/registration";

const now = new Date("2026-11-22T12:00:00.000Z");

function row(extra: Partial<RegistrationRow> = {}): RegistrationRow {
  return {
    instanceId: "inst",
    state: "ok",
    circuitOpenedAt: null,
    circuitFailures: 0,
    nextProbeAt: null,
    pausedUntil: null,
    statusCheckedAt: null,
    ...extra,
  } as RegistrationRow;
}

describe("relayStatusOf", () => {
  it("keeps the closed values of a status answer and nothing else", () => {
    expect(
      relayStatusOf(
        {
          state: "maintenance",
          devices: { active: 3, provisional: 1, limit: 50 },
          notice: { id: "x", level: "info" },
          registration: "invite",
          extra: "free text",
        },
        now,
      ),
    ).toEqual({
      at: now.toISOString(),
      state: "maintenance",
      devices: { active: 3, provisional: 1, limit: 50 },
      wallet: null,
    });
  });

  it("keeps the Wallet block's closed values; signing needs both identifiers", () => {
    const wallet = (block: unknown) =>
      relayStatusOf({ state: "ok", wallet: block }, now)?.wallet;
    expect(
      wallet({
        sign: true,
        notify: true,
        passTypeIdentifier: "pass.dev.healthlog.emergency",
        teamIdentifier: "ABCDE12345",
        certNotAfterDay: 20800,
        note: "free text",
      }),
    ).toEqual({
      sign: true,
      notify: true,
      passTypeIdentifier: "pass.dev.healthlog.emergency",
      teamIdentifier: "ABCDE12345",
      certNotAfterDay: 20800,
    });
    expect(
      wallet({ sign: true, notify: true, passTypeIdentifier: "evil" }),
    ).toMatchObject({ sign: false, notify: false, passTypeIdentifier: null });
    expect(wallet({ sign: false, notify: false })).toMatchObject({
      sign: false,
    });
    expect(wallet("yes")).toBeNull();
  });

  it("refuses an unknown state and drops malformed counts", () => {
    expect(relayStatusOf({ state: "broken" }, now)).toBeNull();
    expect(relayStatusOf(null, now)).toBeNull();
    expect(
      relayStatusOf({ state: "ok", devices: { active: -1, limit: 5 } }, now)
        ?.devices,
    ).toBeNull();
  });
});

describe("stateForReported", () => {
  it("maps every reported state onto this server's state and a known reason", () => {
    expect(stateForReported("ok")).toEqual({ state: "ok", reason: null });
    for (const s of ["degraded", "maintenance", "misconfigured"] as const) {
      const mapped = stateForReported(s);
      expect(mapped.state).toBe("degraded");
      expect(RELAY_REPORTED_REASONS.has(mapped.reason as string)).toBe(true);
    }
  });
});

describe("anyItemAccepted", () => {
  it("is true only for an item Apple accepted", () => {
    expect(
      anyItemAccepted({ results: [{ status: 200, result: "accepted" }] }),
    ).toBe(true);
    expect(
      anyItemAccepted({
        results: [{ status: 503, error: "apns_unavailable" }],
      }),
    ).toBe(false);
    expect(anyItemAccepted({})).toBe(false);
  });
});

describe("statusCheckDue", () => {
  it("is due once an hour", () => {
    expect(statusCheckDue(row(), now)).toBe(true);
    expect(
      statusCheckDue(
        row({
          statusCheckedAt: new Date(now.getTime() - STATUS_INTERVAL_MS + 1),
        }),
        now,
      ),
    ).toBe(false);
    expect(
      statusCheckDue(
        row({ statusCheckedAt: new Date(now.getTime() - STATUS_INTERVAL_MS) }),
        now,
      ),
    ).toBe(true);
  });

  it("is not asked while the breaker probes, the relay paused us, or the instance is gone", () => {
    expect(statusCheckDue(row({ circuitOpenedAt: now }), now)).toBe(false);
    expect(
      statusCheckDue(row({ pausedUntil: new Date(now.getTime() + 1) }), now),
    ).toBe(false);
    expect(statusCheckDue(row({ state: "revoked" }), now)).toBe(false);
    expect(statusCheckDue(row({ instanceId: null }), now)).toBe(false);
  });
});

describe("storedRelayStatus", () => {
  it("reads back what was stored and nothing malformed", () => {
    const stored = relayStatusOf(
      { state: "ok", devices: { active: 1, provisional: 0, limit: 5 } },
      now,
    );
    expect(storedRelayStatus(JSON.parse(JSON.stringify(stored)))).toEqual(
      stored,
    );
    expect(storedRelayStatus({ at: "not a date", state: "ok" })).toBeNull();
    expect(storedRelayStatus(null)).toBeNull();
  });
});

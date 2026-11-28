/**
 * The integrations list rows, resolved on the server.
 *
 * Nothing on the connection-health model may render nowhere: every
 * connection key is a source row. And the three status words are decided
 * here, once, from the health state and the channel reliability fields.
 */
import { describe, expect, it } from "vitest";

import {
  CONNECTION_KEYS,
  type ConnectionHealth,
  type ConnectionHealthState,
} from "../connection-health";
import {
  OVERVIEW_SOURCE_KEYS,
  resolveChannelItem,
  resolveSourceItem,
} from "../overview";

function health(
  state: ConnectionHealthState,
  reason: ConnectionHealth["reason"],
): ConnectionHealth {
  return {
    state,
    reason,
    since: null,
    action: null,
    unavailable: [],
    lastSuccessAt: "2026-11-27T08:06:00.000Z",
    lastDataAt: "2026-11-27T07:00:00.000Z",
    diagnostics: {} as ConnectionHealth["diagnostics"],
  };
}

const NOW = new Date("2026-11-27T12:00:00.000Z");

describe("source rows", () => {
  it("cover every connection key", () => {
    for (const key of CONNECTION_KEYS) {
      expect(OVERVIEW_SOURCE_KEYS as readonly string[]).toContain(key);
    }
  });

  it("are not set up while nothing is stored", () => {
    expect(
      resolveSourceItem({
        key: "oura",
        connected: false,
        configured: false,
        health: null,
        offered: true,
        needsOwnCredentials: true,
      }),
    ).toMatchObject({
      setUp: false,
      status: null,
      reason: null,
      setupNote: "own_credentials",
    });
  });

  it("read off with a reason when credentials are stored but nothing is connected", () => {
    expect(
      resolveSourceItem({
        key: "withings",
        connected: false,
        configured: true,
        health: null,
        offered: true,
      }),
    ).toMatchObject({ setUp: true, status: "off", reason: "not_connected" });
  });

  it.each([
    ["ok", "data_arriving", "active"],
    ["limited", "plan_limited", "active"],
    ["degraded", "sync_stalled", "error"],
    ["action_required", "reauth_required", "error"],
  ] as const)("map health %s to %s", (state, reason, status) => {
    const item = resolveSourceItem({
      key: "whoop",
      connected: true,
      configured: true,
      health: health(state, reason),
      offered: true,
    });
    expect(item).toMatchObject({ setUp: true, status, reason });
    expect(item.lastAt).toBe("2026-11-27T08:06:00.000Z");
    // A connected source needs no credential note.
    expect(item.setupNote).toBeNull();
  });

  it("read off when the person paused a set-up folder", () => {
    expect(
      resolveSourceItem({
        key: "health-connect-remote",
        connected: false,
        configured: true,
        paused: true,
        health: null,
        offered: true,
      }),
    ).toMatchObject({ setUp: true, status: "off", reason: "paused" });
  });
});

describe("channel rows", () => {
  const row = {
    enabled: true,
    disabledReason: null,
    consecutiveFailures: 0,
    lastSuccessAt: new Date("2026-11-26T20:30:00.000Z"),
    lastFailureAt: null,
    nextRetryAt: null,
  };

  it("are not set up without a channel row", () => {
    expect(
      resolveChannelItem({
        key: "telegram",
        row: null,
        offered: true,
        now: NOW,
      }),
    ).toMatchObject({ setUp: false, status: null });
  });

  it("read active with the last delivery", () => {
    expect(
      resolveChannelItem({ key: "ntfy", row, offered: true, now: NOW }),
    ).toMatchObject({
      status: "active",
      reason: null,
      lastAt: "2026-11-26T20:30:00.000Z",
    });
  });

  it.each([
    [{ enabled: false }, "off", "switched_off"],
    [
      { enabled: false, disabledReason: "hard_reject_410" },
      "error",
      "auto_disabled",
    ],
    [
      { nextRetryAt: new Date("2026-11-27T13:00:00.000Z") },
      "error",
      "sending_paused",
    ],
    [
      {
        consecutiveFailures: 2,
        lastFailureAt: new Date("2026-11-27T09:00:00.000Z"),
      },
      "error",
      "delivery_failing",
    ],
  ] as const)("read %o as %s", (patch, status, reason) => {
    expect(
      resolveChannelItem({
        key: "webhook",
        row: { ...row, ...patch },
        offered: true,
        now: NOW,
      }),
    ).toMatchObject({ setUp: true, status, reason });
  });

  it("forget a failure an older success already covered", () => {
    expect(
      resolveChannelItem({
        key: "email",
        row: {
          ...row,
          consecutiveFailures: 0,
          lastFailureAt: new Date("2026-11-20T09:00:00.000Z"),
        },
        offered: true,
        now: NOW,
      }).status,
    ).toBe("active");
  });

  it("a cooldown in the past is over", () => {
    expect(
      resolveChannelItem({
        key: "telegram",
        row: { ...row, nextRetryAt: new Date("2026-11-27T11:00:00.000Z") },
        offered: true,
        now: NOW,
      }).status,
    ).toBe("active");
  });
});

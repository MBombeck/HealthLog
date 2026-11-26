import { describe, expect, it } from "vitest";

import {
  attemptOutcome,
  diagnosticDevice,
  diagnosticPushAttempt,
  maskApnsToken,
  relayDeliveryOutcome,
} from "@/lib/push-relay/diagnostics";
import {
  silentBudgetAllows,
  silentBudgetSummary,
  type SilentWindowRow,
} from "@/lib/push-relay/wakes";

const MIN = 60_000;
const T0 = new Date("2026-11-22T10:00:00.000Z");

function window(kinds: string[]): SilentWindowRow[] {
  return kinds.map((kind, i) => ({
    kind,
    createdAt: new Date(T0.getTime() + i * MIN),
  }));
}

describe("silent budget", () => {
  it("keeps the last two relay slots for the intake sync", () => {
    const four = window([
      "DATA_CHANGED",
      "MEDICATION_INTAKE_SYNC",
      "MEDICATION_INTAKE_SYNC",
      "HEALTHKIT_CATCH_UP",
    ]);
    expect(silentBudgetAllows(four, "relay", "HEALTHKIT_CATCH_UP")).toBe(false);
    expect(silentBudgetAllows(four, "relay", "MEDICATION_INTAKE_SYNC")).toBe(
      true,
    );
    // Over the server's own key only the wake limits apply.
    expect(silentBudgetAllows(four, "direct", "HEALTHKIT_CATCH_UP")).toBe(true);
  });

  it("caps wakes at four and DATA_CHANGED at three on any route", () => {
    const wakes = window([
      "DATA_CHANGED",
      "DATA_CHANGED",
      "DATA_CHANGED",
      "HEALTHKIT_CATCH_UP",
    ]);
    expect(silentBudgetAllows(wakes, "direct", "HEALTHKIT_CATCH_UP")).toBe(
      false,
    );
    const three = wakes.slice(0, 3);
    expect(silentBudgetAllows(three, "direct", "DATA_CHANGED")).toBe(false);
    expect(silentBudgetAllows(three, "direct", "HEALTHKIT_CATCH_UP")).toBe(
      true,
    );
  });

  it("summarises the numbers the send rule reads", () => {
    const rows = window([
      "DATA_CHANGED",
      "MEDICATION_INTAKE_SYNC",
      "HEALTHKIT_CATCH_UP",
    ]);
    expect(silentBudgetSummary(rows, "relay")).toEqual({
      windowMinutes: 60,
      limit: 6,
      wakeLimit: 4,
      usedInWindow: 3,
      wakesUsedInWindow: 2,
      nextFreeAt: null,
    });
    expect(silentBudgetSummary(rows, "direct").limit).toBeNull();
  });

  it("names when a spent relay budget frees up for the sync", () => {
    const six = window(Array(6).fill("MEDICATION_INTAKE_SYNC"));
    expect(silentBudgetSummary(six, "relay").nextFreeAt).toEqual(
      new Date(T0.getTime() + 60 * MIN),
    );
    // Seven in the window: two have to age out, the second one sets the time.
    const seven = window(Array(7).fill("MEDICATION_INTAKE_SYNC"));
    expect(silentBudgetSummary(seven, "relay").nextFreeAt).toEqual(
      new Date(T0.getTime() + 61 * MIN),
    );
    // A sync always fits over the server's own key.
    expect(silentBudgetSummary(seven, "direct").nextFreeAt).toBeNull();
  });

  it("agrees with the send rule on every window size", () => {
    for (let n = 0; n <= 8; n++) {
      const rows = window(Array(n).fill("MEDICATION_INTAKE_SYNC"));
      const free = silentBudgetSummary(rows, "relay").nextFreeAt === null;
      expect(free).toBe(
        silentBudgetAllows(rows, "relay", "MEDICATION_INTAKE_SYNC"),
      );
    }
  });
});

describe("diagnostic shapes", () => {
  it("masks an APNs token to eight characters each side", () => {
    const token = "a".repeat(8) + "0".repeat(48) + "b".repeat(8);
    expect(maskApnsToken(token)).toEqual({
      prefix: "aaaaaaaa",
      suffix: "bbbbbbbb",
    });
    expect(maskApnsToken("short")).toEqual({ prefix: null, suffix: null });
    expect(maskApnsToken(null)).toEqual({ prefix: null, suffix: null });
  });

  it("reads a relay outbox row as an outcome", () => {
    const at = new Date();
    expect(relayDeliveryOutcome({ status: "pending", confirmedAt: null })).toBe(
      "pending",
    );
    expect(
      relayDeliveryOutcome({ status: "accepted", confirmedAt: null }),
    ).toBe("accepted");
    expect(relayDeliveryOutcome({ status: "accepted", confirmedAt: at })).toBe(
      "opened",
    );
    expect(relayDeliveryOutcome({ status: "dropped", confirmedAt: null })).toBe(
      "dropped",
    );
    expect(relayDeliveryOutcome({ status: "failed", confirmedAt: null })).toBe(
      "failed",
    );
  });

  it("reads a delivery attempt as an outcome", () => {
    expect(attemptOutcome("ok")).toBe("accepted");
    expect(attemptOutcome("skipped")).toBe("skipped");
    expect(attemptOutcome("error")).toBe("failed");
  });

  it("maps an attempt and a device the way the admin diagnostic lists them", () => {
    const at = new Date("2026-11-22T09:00:00.000Z");
    expect(
      diagnosticPushAttempt({
        userId: "u1",
        recordUserId: null,
        recipientUserId: null,
        eventType: "MEDICATION_REMINDER",
        channel: "APNS",
        result: "ok",
        reason: null,
        createdAt: at,
      }),
    ).toEqual({
      recordUserId: "u1",
      recipientUserId: "u1",
      eventType: "MEDICATION_REMINDER",
      channel: "APNS",
      result: "ok",
      reason: null,
      at: at.toISOString(),
    });
    const device = diagnosticDevice({
      id: "d1",
      platform: "ios",
      apnsToken: "",
      apnsEnvironment: null,
      lastSeen: at,
      relayState: "none",
      relayConflictAt: null,
      relayBoundAt: null,
      laStartedAt: null,
      envelopeReportedAt: null,
    });
    expect(device.hasApnsToken).toBe(false);
    expect(device.apnsTokenPrefix).toBeNull();
  });
});

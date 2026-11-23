/**
 * A relay per-item refusal is never a success.
 *
 * The relay answers `200` for a batch and refuses items inside it. A flush
 * that read the batch, or "something was handed on", as sent logged an
 * intake sync the relay had refused for the device's silent budget as `ok`,
 * never owed it, and the device never got it. Two rules hold that shut:
 * every result code has one reading (`classifyRelayAnswer`), and every
 * sealed send is `ok` only when the push to every device was accepted
 * (`sealedOutcome`).
 */
import { describe, expect, it } from "vitest";

import {
  classifyRelayAnswer,
  type RelayItemOutcome,
} from "@/lib/push-relay/relay-send";
import {
  attemptResultOf,
  sealedOutcome,
  type SealedDeviceResult,
} from "@/lib/push-relay/route-device";

describe("what each relay result code means", () => {
  it.each([
    // Delivered: the only one.
    [200, "accepted", "accepted"],
    // Budgets: waited out, a silent push owed.
    [429, "device_quota", "budget"],
    [429, "binding_quota", "budget"],
    [429, "instance_quota", "budget"],
    [429, "instance_rate", "budget"],
    [429, "global", "budget"],
    [429, "silent_budget", "budget"],
    [429, "rate_limited", "budget"],
    [429, "something_new", "budget"],
    // Outages: retried.
    [503, "apns_unavailable", "transient"],
    [503, "maintenance", "transient"],
    [503, "queue_full", "transient"],
    [503, "relay_misconfigured", "transient"],
    [500, "internal", "transient"],
    [504, "timeout", "transient"],
    [0, "missing", "transient"],
    [0, "timeout", "transient"],
    // Final, the binding handled where it has to be.
    [404, "binding_unknown", "rebind"],
    [410, "unregistered", "unregistered"],
    [200, "soft_invalid", "final"],
    [200, "activity_gone", "final"],
    [403, "activity_refused", "final"],
    [403, "liveactivity_consent_required", "final"],
    [422, "invalid_item", "final"],
    [401, "bad_signature", "final"],
    [409, "unbound", "final"],
    [502, "apns_rejected", "final"],
  ] as const)("%i %s is %s", (status, code, kind) => {
    expect(classifyRelayAnswer(status, code)).toBe(kind);
  });

  it("reads a budget code as a budget whatever status carries it", () => {
    expect(classifyRelayAnswer(200, "device_quota")).toBe("budget");
    expect(classifyRelayAnswer(503, "silent_budget")).toBe("budget");
  });

  it("never reads anything but 200 accepted as delivered", () => {
    for (const status of [0, 200, 201, 202, 204, 429, 503]) {
      for (const code of ["accepted", "ok", "sent", "device_quota", ""]) {
        const delivered = classifyRelayAnswer(status, code) === "accepted";
        expect(delivered).toBe(status === 200 && code === "accepted");
      }
    }
  });
});

const OUTCOMES: RelayItemOutcome[] = ["accepted", "waiting", "owed", "failed"];

function devicesOf(
  outcomes: readonly RelayItemOutcome[],
): Record<string, SealedDeviceResult> {
  return Object.fromEntries(
    outcomes.map((outcome, i) => [
      `d${i}`,
      {
        outcome,
        code: outcome === "accepted" ? null : "device_quota",
        via: "relay" as const,
      },
    ]),
  );
}

const sealed = (outcomes: readonly RelayItemOutcome[]) => ({
  devices: devicesOf(outcomes),
  lastFailure: null,
  waitReason: "relay_waiting" as const,
});

describe("a sealed send is ok only when every device accepted", () => {
  it("holds for every mix of up to three devices", () => {
    const mixes: RelayItemOutcome[][] = [[]];
    for (let n = 0; n < 3; n += 1) {
      for (const mix of [...mixes]) {
        for (const o of OUTCOMES) mixes.push([...mix, o]);
      }
    }
    for (const mix of mixes) {
      const out = sealedOutcome(sealed(mix));
      const allAccepted = mix.length > 0 && mix.every((o) => o === "accepted");
      expect(out.result === "ok", JSON.stringify(mix)).toBe(allAccepted);
      if (out.result !== "ok") expect(out.reason).toBeTruthy();
      // A failure wins over a wait, a wait over a delivery.
      if (mix.includes("failed")) expect(out.result).toBe("error");
      else if (mix.some((o) => o === "owed" || o === "waiting")) {
        expect(out.result).toBe("deferred");
      }
    }
  });

  it("names the relay's refusal of a silent push as owed", () => {
    expect(sealedOutcome(sealed(["accepted", "owed"]))).toEqual({
      result: "deferred",
      reason: "relay_owed:device_quota",
    });
    expect(sealedOutcome(sealed(["waiting"]))).toEqual({
      result: "deferred",
      reason: "relay_waiting",
    });
    expect(sealedOutcome(sealed(["accepted", "failed"]))).toEqual({
      result: "error",
      reason: "relay_item_failed:device_quota",
    });
  });

  it("keeps Apple's own reason on a direct send", () => {
    expect(
      sealedOutcome({
        devices: {
          d: { outcome: "failed", code: "BadDeviceToken", via: "direct" },
        },
        lastFailure: "BadDeviceToken",
        waitReason: "relay_waiting",
      }),
    ).toEqual({ result: "error", reason: "BadDeviceToken" });
  });

  it("records a deferred push as skipped, never as ok", () => {
    expect(attemptResultOf({ result: "deferred" })).toBe("skipped");
    expect(attemptResultOf({ result: "error" })).toBe("error");
    expect(attemptResultOf({ result: "ok" })).toBe("ok");
  });
});

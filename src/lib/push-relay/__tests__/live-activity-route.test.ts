/**
 * A Live Activity start or update goes over the relay whatever way the
 * device's ordinary pushes take. On a server with its own APNs key and a
 * relay registration every bound device read `direct` (`routeFor`), and the
 * Live Activity eligibility asked for `relay`, so no Activity ever started
 * there. The eligibility reads the relay's own reach now; `routeFor` stays
 * the one rule for ordinary pushes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import {
  laRelayBlock,
  laRelayEligible,
  liveActivityStartState,
} from "../live-activity-eligibility";
import { relayReachable, routeOf, type PushContext } from "../route-device";

const NOW = new Date("2026-11-26T12:00:00Z");
const iat = Math.floor(NOW.getTime() / 1000) - 60;

const device = {
  id: "d1",
  apnsToken: "ab".repeat(32),
  apnsEnvironment: "production",
  pushKeyPublic: "k".repeat(43),
  relayState: "bound",
  relayConsentAt: new Date("2026-11-01T00:00:00Z"),
  relayBindingKey: Buffer.alloc(32, 1).toString("base64url"),
  liveActivityConsentAt: new Date("2026-11-02T00:00:00Z"),
  laStartToken: "5a".repeat(32),
  laStartSignature: "sig",
  laStartStatement: { iat },
};

function ctx(apnsConfigured: boolean): PushContext {
  return {
    config: {} as PushContext["config"],
    registration: { instanceId: "inst-1" } as PushContext["registration"],
    apnsConfigured,
    bundleId: apnsConfigured ? "dev.healthlog.app" : null,
    keys: {} as NonNullable<PushContext["keys"]>,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Live Activity eligibility", () => {
  it("does not depend on the instance's own APNs key", () => {
    vi.stubEnv("PUSH_RELAY_LIVE_ACTIVITY", "on");
    // Ordinary pushes take the key; the relay still reaches the device.
    expect(routeOf(device, ctx(true))).toBe("direct");
    expect(relayReachable(device, ctx(true))).toBe(true);
    expect(laRelayEligible(device, ctx(true))).toBe(true);
    expect(laRelayEligible(device, ctx(false))).toBe(true);
    expect(liveActivityStartState(device, ctx(true), NOW)).toBe("ready");
  });

  it("names the first thing in the way", () => {
    vi.stubEnv("PUSH_RELAY_LIVE_ACTIVITY", "");
    expect(laRelayBlock(device, ctx(true))).toBe("switch_off");
    vi.stubEnv("PUSH_RELAY_LIVE_ACTIVITY", "on");
    expect(
      laRelayBlock({ ...device, relayState: "rebind_needed" }, ctx(true)),
    ).toBe("not_bound");
    expect(laRelayBlock({ ...device, relayConsentAt: null }, ctx(true))).toBe(
      "not_bound",
    );
    expect(laRelayBlock(device, { ...ctx(true), registration: null })).toBe(
      "not_bound",
    );
    expect(laRelayBlock({ ...device, relayBindingKey: null }, ctx(true))).toBe(
      "not_bound",
    );
    expect(
      laRelayBlock({ ...device, liveActivityConsentAt: null }, ctx(true)),
    ).toBe("no_consent");
    expect(
      liveActivityStartState({ ...device, laStartToken: null }, ctx(true), NOW),
    ).toBe("no_start_token");
    expect(
      liveActivityStartState(
        { ...device, laStartStatement: { iat: iat - 31 * 24 * 3600 } },
        ctx(true),
        NOW,
      ),
    ).toBe("no_start_token");
  });
});

/**
 * One routing rule. The send (`routeOf`) and what `/api/auth/me` says about
 * the device (`push.device.transport`) used to be two functions: the display
 * said `relay` for a device the send could not seal for, and `direct` for a
 * device that got plaintext. Both read `routeFor` now; the matrix pins the
 * rule, and the structural half keeps the display on it.
 */
import { describe, expect, it, vi } from "vitest";

import {
  readSource,
  stripComments,
} from "../../../__tests__/helpers/source-files";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import { routeFor, type RoutableDevice } from "../route-device";

const bound: RoutableDevice = {
  id: "d1",
  apnsToken: "ab".repeat(32),
  apnsEnvironment: "production",
  pushKeyPublic: "k".repeat(43),
  relayState: "bound",
  relayConsentAt: new Date("2026-11-01T00:00:00Z"),
};
const relay = { instanceId: "inst-1", state: "ok" };

describe("routeFor", () => {
  it.each([
    ["no APNs token", { apnsToken: null }, true, relay, true, "none"],
    [
      "no push key, own APNs key",
      { pushKeyPublic: null },
      true,
      null,
      true,
      "legacy",
    ],
    [
      "no push key, relay only",
      { pushKeyPublic: null },
      false,
      relay,
      true,
      "none",
    ],
    ["push key, no sender keys", {}, true, relay, false, "none"],
    ["push key, own APNs key", {}, true, relay, true, "direct"],
    ["push key, relay, bound with consent", {}, false, relay, true, "relay"],
    [
      "push key, relay, not bound",
      { relayState: "rebind_needed" },
      false,
      relay,
      true,
      "none",
    ],
    [
      "push key, relay, no consent",
      { relayConsentAt: null },
      false,
      relay,
      true,
      "none",
    ],
    ["push key, relay off", {}, false, null, true, "none"],
  ] as const)(
    "%s",
    (_label, overrides, apnsConfigured, registration, canSeal, expected) => {
      expect(
        routeFor(
          { ...bound, ...overrides },
          { apnsConfigured, registration, canSeal },
        ),
      ).toBe(expected);
    },
  );
});

describe("the /me transport reads the same rule", () => {
  const source = stripComments(
    readSource("src/lib/push-relay/capability.ts", "displayTransport"),
  );

  it("derives the transport from routeFor and keeps no rule of its own", () => {
    expect(source).toMatch(/\brouteFor\s*\(/);
    expect(source).not.toMatch(/relayState\s*===\s*"bound"/);
    expect(source).not.toMatch(/\bdeviceTransport\b/);
  });
});

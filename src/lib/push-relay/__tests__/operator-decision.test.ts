/**
 * What `push.relay.operatorDecision` publishes for every combination of the
 * stored answer, the registration and the server's means
 * (`operator-decision.ts`).
 */
import { describe, expect, it } from "vitest";

import {
  operatorDecisionOf,
  storedRelayDecisionOf,
} from "@/lib/push-relay/operator-decision";

const open = {
  offered: false,
  registered: false,
  available: true,
  apnsConfigured: false,
};
/** Registered at the relay: what `routeFor` sends by. */
const live = { offered: true, registered: true };

describe("operatorDecisionOf", () => {
  it.each([
    ["nobody answered", { ...open, stored: null }, "undecided"],
    ["no is final", { ...open, stored: "off" }, "off"],
    [
      "no is final while a registration is unfinished",
      { ...open, stored: "off", offered: true },
      "off",
    ],
    [
      "yes with the registration",
      { ...open, stored: "on", offered: true },
      "on",
    ],
    [
      "yes carried onto a host without the registration asks again",
      { ...open, stored: "on" },
      "undecided",
    ],
    [
      "a registration the switch left unfinished is still undecided",
      { ...open, stored: null, offered: true },
      "undecided",
    ],
    [
      "nothing to decide without the relay",
      { ...open, stored: null, available: false },
      "off",
    ],
    [
      "nothing to decide beside an APNs key of its own",
      { ...open, stored: null, apnsConfigured: true },
      "off",
    ],
    [
      "a registration with an instance id is on, a restored no beside it included",
      { ...open, ...live, stored: "off" },
      "on",
    ],
    [
      "a registration with an instance id is on with nothing stored",
      { ...open, ...live, stored: null },
      "on",
    ],
    [
      "a registered yes stays on beside an APNs key",
      { ...open, stored: "on", offered: true, apnsConfigured: true },
      "on",
    ],
  ] as const)("%s", (_, input, expected) => {
    expect(operatorDecisionOf(input)).toBe(expected);
  });

  it("reads only the two values the column's CHECK admits", () => {
    expect(storedRelayDecisionOf("on")).toBe("on");
    expect(storedRelayDecisionOf("off")).toBe("off");
    expect(storedRelayDecisionOf("maybe")).toBeNull();
    expect(storedRelayDecisionOf(null)).toBeNull();
  });
});

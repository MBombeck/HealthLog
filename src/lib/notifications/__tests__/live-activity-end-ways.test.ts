/**
 * A leaving device's Activities end the way their starter can end them: a
 * relay-started one over the relay, whatever way the device's ordinary
 * pushes take; an app-started one over the device's route. On a server with
 * its own APNs key a relay-started Activity went out over that key, with
 * the app's content state, which its attributes type does not read.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import { leaveEndWays } from "../live-activity-end";

const relay = { id: "r", pushToken: "aa", relayStarted: true };
const app = { id: "a", pushToken: "bb", relayStarted: false };
const device = { liveActivities: [relay, app], liveActivityPushToken: "cc" };

describe("leaveEndWays", () => {
  it("ends everything over the relay on a relay-routed device", () => {
    expect(leaveEndWays(device, "relay")).toEqual({
      overRelay: [relay, app],
      ownKey: [],
    });
  });

  it.each(["direct", "legacy"] as const)(
    "ends the relay-started one over the relay on a %s device",
    (route) => {
      expect(leaveEndWays(device, route)).toEqual({
        overRelay: [relay],
        ownKey: ["bb", "cc"],
      });
    },
  );

  it("sends nothing over the server's key on a device with no route", () => {
    expect(leaveEndWays(device, "none")).toEqual({
      overRelay: [relay],
      ownKey: [],
    });
  });
});

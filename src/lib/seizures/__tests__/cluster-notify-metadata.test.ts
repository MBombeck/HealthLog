/**
 * The cluster push names the seizure that formed the cluster, as an id and as
 * the path that opens it. Mutation check: drop `url` from the metadata → red.
 */
import { describe, expect, it, vi } from "vitest";

const now = new Date();
const dispatch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({
  prisma: {
    seizureEvent: {
      findFirst: vi.fn(async () => ({ onsetAt: now })),
      findMany: vi.fn(async () => [
        { id: "a", onsetAt: new Date(now.getTime() - 60_000), count: 1 },
        { id: "b", onsetAt: now, count: 1 },
      ]),
    },
    seizureClusterAlert: { createMany: vi.fn(async () => ({ count: 1 })) },
    user: {
      findUnique: vi.fn(async () => ({ username: "carer", displayName: null })),
    },
  },
}));
vi.mock("@/lib/notifications/dispatch-localised", () => ({
  dispatchLocalisedNotification: dispatch,
}));
vi.mock("../server", () => ({
  readClusterRule: async () => ({ count: 2, windowHours: 24 }),
}));

import { notifySeizureCluster } from "../cluster-notify";

describe("notifySeizureCluster metadata", () => {
  it("carries the eventId and the path that opens it", async () => {
    await notifySeizureCluster({ ownerId: "o", actorId: "c", eventId: "b" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]![0].metadata).toEqual({
      eventId: "b",
      url: "/seizures?event=b",
    });
  });
});

/**
 * Which registered Live Activity the relay may update and end. Updates carry
 * `countdownTarget` in unix seconds, which only the Activity the relay
 * started (`HealthLogDoseAttributes`) reads; the app's own Activity
 * (`MedicationActivityAttributes`) reads seconds since 2001-01-01, so it gets
 * no relay update, only the end, whose fixed state carries no time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendRelayItems = vi.fn();
vi.mock("@/lib/push-relay/relay-send", () => ({
  sendRelayItems: (...args: unknown[]) => sendRelayItems(...args),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    pushRelayDelivery: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
    },
  },
}));
vi.mock("@/lib/push-relay/route-device", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  routeOf: () => "relay",
}));

import { relayUpdateItem } from "@/lib/push-relay/live-activity";
import { doseContentState } from "@/lib/push-relay/live-activity-content";
import {
  relayActivityKind,
  relayEventAllowed,
} from "@/lib/push-relay/live-activity-owner";
import { endActivitiesOverRelay } from "@/lib/push-relay/medication-pushes";
import type { PushContext } from "@/lib/push-relay/route-device";
import { resolveDoseState } from "@/lib/medications/dose-state/resolve";

const NOW = new Date("2026-11-23T08:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const BINDING_KEY = Buffer.alloc(32, 7).toString("base64url");
const device = { id: "dev-1", relayBindingKey: BINDING_KEY };

function activity(relayStarted: boolean, token: string) {
  return {
    id: `row-${token.slice(0, 2)}`,
    pushToken: token,
    relayStarted,
    activityStatement: { iat: NOW_S - 60, laTokenTag: "x" },
    activitySignature: "sig",
  };
}
const RELAY = activity(true, "AB".repeat(32));
const APP = activity(false, "CD".repeat(32));

/** A pending dose due in 20 minutes, as the relay pass would show it. */
function pendingState() {
  const at = (s: number) => new Date(s * 1000);
  const slot = NOW_S + 3600;
  const band = {
    at: at(slot),
    earlyStart: at(slot - 5400),
    onTimeStart: at(slot - 2400),
    onTimeEnd: at(slot + 3600),
    overdueEnd: at(slot + 4 * 3600),
  };
  const state = doseContentState(
    { resolved: resolveDoseState(band, null, NOW), snoozedUntil: null },
    "AUTO",
    NOW,
  );
  if (!state) throw new Error("no state");
  return { state, dueAtS: slot - 2400 };
}

// The pass reads the wall clock (the age of a stored statement, the dose
// state), so the whole file runs on the fixed NOW. Without it the fixture's
// statement, signed a minute before NOW, aged past its 12 hour limit once the
// real clock passed 19:55 UTC on the day NOW names, and the end was dropped.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("who started a registered Activity", () => {
  it("reads the per-token mark", () => {
    expect(relayActivityKind(RELAY)).toBe("relay_started");
    expect(relayActivityKind(APP)).toBe("app_started");
  });

  it("allows an update only to the relay-started one, an end to both", () => {
    expect(relayEventAllowed("relay_started", "update")).toBe(true);
    expect(relayEventAllowed("app_started", "update")).toBe(false);
    expect(relayEventAllowed("relay_started", "end")).toBe(true);
    expect(relayEventAllowed("app_started", "end")).toBe(true);
  });
});

describe("a relay update", () => {
  it("never goes to an Activity the app started", () => {
    const { state } = pendingState();
    expect(relayUpdateItem(device, APP, state, NOW)).toBeNull();
  });

  it("goes to the relay-started Activity with its countdown in unix seconds", () => {
    const { state, dueAtS } = pendingState();
    const item = relayUpdateItem(device, RELAY, state, NOW);
    expect(item?.activity).toMatchObject({
      event: "update",
      token: RELAY.pushToken.toLowerCase(),
      state: { status: "pending", countdownTarget: dueAtS },
    });
    // Unix seconds, not seconds since 2001-01-01 (978307200 s less).
    expect(item?.activity?.state?.countdownTarget).toBeGreaterThan(NOW_S);
  });
});

describe("a relay end", () => {
  beforeEach(() => {
    sendRelayItems.mockReset();
    sendRelayItems.mockResolvedValue({ answers: [], activityGone: [] });
  });

  it("reaches the app-started Activity, carrying no time of its own", async () => {
    const ctx = { config: {} } as unknown as PushContext;
    await endActivitiesOverRelay(
      { ...device, relayBindingKey: BINDING_KEY } as Parameters<
        typeof endActivitiesOverRelay
      >[0],
      [APP, RELAY],
      ctx,
    );
    expect(sendRelayItems).toHaveBeenCalledTimes(1);
    const items = sendRelayItems.mock.calls[0]![0] as Array<{
      activity: Record<string, unknown>;
    }>;
    expect(items.map((i) => i.activity.token)).toEqual([
      APP.pushToken.toLowerCase(),
      RELAY.pushToken.toLowerCase(),
    ]);
    // No event (the relay's default is end) and no state: the relay writes
    // its fixed end state, `countdownTarget: 0`, which no unit can misread.
    for (const item of items) {
      expect(item.activity).not.toHaveProperty("event");
      expect(item.activity).not.toHaveProperty("state");
    }
  });
});

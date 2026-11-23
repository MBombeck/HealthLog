/**
 * The capped relay passes reach every eligible row.
 *
 * The Live Activity pass (every five minutes) and the HealthKit catch-up
 * (hourly) each take 500 rows. Both took the first 500 of a fixed order, so
 * row 501 was never served: a device that never got its Live Activity, an
 * account whose catch-up waited behind 500 older ones kept stale by their
 * per-device limits. The page now rotates with the tick (`pass-window.ts`),
 * so 501 rows are all served within two passes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { FakeRelay, RELAY_PUBLIC_KEY, RELAY_URL } from "./push-relay-fake";

const relay = vi.hoisted(() => ({
  current: null as null | {
    handle: (url: string | URL, init?: RequestInit) => Promise<Response>;
  },
}));
vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return {
    ...actual,
    safeFetch: (url: string | URL, init?: RequestInit) => {
      if (!relay.current) throw new Error("no fake relay");
      return relay.current.handle(url, init);
    },
  };
});

import { getPrismaClient, truncateAllTables } from "./setup";
import { enableRelay } from "./push-relay-kit";
import {
  PASS_LIMIT as LA_LIMIT,
  runLiveActivityRelayPass,
} from "@/lib/push-relay/live-activity";
import {
  PASS_LIMIT as HK_LIMIT,
  runHealthKitCatchUp,
} from "@/lib/push-relay/healthkit-catch-up";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

beforeEach(async () => {
  vi.stubEnv("PUSH_RELAY_URL", RELAY_URL);
  vi.stubEnv("PUSH_RELAY_KEYS", RELAY_PUBLIC_KEY);
  vi.stubEnv("PUSH_RELAY_LIVE_ACTIVITY", "on");
  await truncateAllTables(getPrismaClient());
  relay.current = new FakeRelay();
});

/** The start of an even-numbered period, so the next one is page 1. */
function evenTick(periodMs: number): Date {
  let tick = Math.floor(Date.now() / periodMs);
  if (tick % 2 === 1) tick += 1;
  return new Date(tick * periodMs + 1000);
}

async function users(n: number): Promise<string[]> {
  const prisma = getPrismaClient();
  const ids = Array.from({ length: n }, (_, i) => `pass-user-${i}`);
  await prisma.user.createMany({
    data: ids.map((id) => ({
      id,
      username: id,
      email: `${id}@example.test`,
      role: "USER" as const,
    })),
  });
  return ids;
}

describe("capped relay passes", () => {
  it("the Live Activity pass serves device 501 on the next tick", async () => {
    await enableRelay();
    expect(LA_LIMIT).toBe(500);
    const ids = await users(LA_LIMIT + 1);
    const at = new Date();
    await getPrismaClient().device.createMany({
      data: ids.map((userId, i) => ({
        userId,
        platform: "ios",
        token: `pass-device-${i}`,
        bundleId: "dev.healthlog.app",
        apnsToken: i.toString(16).padStart(64, "0"),
        apnsEnvironment: "production",
        pushKeyPublic: "k".repeat(43),
        relayState: "bound",
        relayConsentAt: at,
        liveActivityConsentAt: at,
      })),
    });
    const t0 = evenTick(5 * MINUTE);
    expect((await runLiveActivityRelayPass(t0)).devices).toBe(LA_LIMIT);
    const t1 = new Date(t0.getTime() + 5 * MINUTE);
    expect((await runLiveActivityRelayPass(t1)).devices).toBe(1);
  });

  it("the HealthKit catch-up reaches account 501 within two hours", async () => {
    expect(HK_LIMIT).toBe(500);
    const t0 = evenTick(HOUR);
    const ids = await users(HK_LIMIT + 1);
    // Every account's upload is a day behind, so every one is a candidate.
    await getPrismaClient().healthKitTypeSync.createMany({
      data: ids.map((userId) => ({
        userId,
        type: "HKQuantityTypeIdentifierStepCount",
        lastReceivedAt: new Date(t0.getTime() - 24 * HOUR),
      })),
    });
    expect((await runHealthKitCatchUp(t0)).candidates).toBe(HK_LIMIT);
    const t1 = new Date(t0.getTime() + HOUR);
    expect((await runHealthKitCatchUp(t1)).candidates).toBe(1);
  });
});

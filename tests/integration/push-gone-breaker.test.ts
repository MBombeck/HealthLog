/**
 * The breaker in front of every verdict-driven registration delete
 * (`src/lib/notifications/gone-registrations.ts`), against a real Postgres:
 * the window and the hold live in `rate_limits`, so a mocked client would
 * prove nothing about the upserts that carry them.
 *
 * One gone device is deleted at once. Fifty reported gone in one window are
 * a configuration error: none is deleted, the hold is listed for the admin
 * status page, and a later single verdict is held too.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const USER = "user-push-gone-breaker";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  await getPrismaClient().user.create({
    data: { id: USER, username: "push-gone", email: "push-gone@example.test" },
  });
});

async function seedDevices(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const device = await getPrismaClient().device.create({
      data: {
        userId: USER,
        platform: "ios",
        token: `install-${i}`,
        bundleId: "test.healthlog.ios",
        apnsToken: `apns-${i}`,
        apnsEnvironment: "production",
      },
    });
    ids.push(device.id);
  }
  return ids;
}

describe("forgetGoneRegistrations (real Postgres)", () => {
  it("deletes one device reported gone", async () => {
    const { forgetGoneRegistrations, readGoneHolds } =
      await import("@/lib/notifications/gone-registrations");
    const [id, other] = await seedDevices(2);

    expect(await forgetGoneRegistrations("device", [id])).toBe(true);

    const left = await getPrismaClient().device.findMany({
      select: { id: true },
    });
    expect(left.map((d) => d.id)).toEqual([other]);
    expect(await readGoneHolds()).toEqual([]);
  });

  it("deletes none of fifty devices reported gone in one window and raises the alarm", async () => {
    const { forgetGoneRegistrations, readGoneHolds, GONE_LIMIT } =
      await import("@/lib/notifications/gone-registrations");
    const ids = await seedDevices(50);

    expect(await forgetGoneRegistrations("device", ids)).toBe(false);

    expect(await getPrismaClient().device.count()).toBe(50);
    const holds = await readGoneHolds();
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ channel: "apns", count: 50 });
    expect(holds[0].until.getTime()).toBeGreaterThan(Date.now());

    // The hold covers what follows, a single verdict included.
    expect(await forgetGoneRegistrations("device", [ids[0]])).toBe(false);
    expect(await getPrismaClient().device.count()).toBe(50);
    expect(GONE_LIMIT).toBeLessThan(50);
  });

  it("opens the breaker once verdicts one dispatch at a time pass the limit", async () => {
    const { forgetGoneRegistrations, readGoneHolds, GONE_LIMIT } =
      await import("@/lib/notifications/gone-registrations");
    const ids = await seedDevices(50);

    const results: boolean[] = [];
    for (const id of ids) {
      results.push(await forgetGoneRegistrations("device", [id]));
    }

    // Each verdict up to the limit is taken at its word; none after it.
    expect(results.filter(Boolean)).toHaveLength(GONE_LIMIT);
    expect(results.slice(0, GONE_LIMIT).every(Boolean)).toBe(true);
    expect(await getPrismaClient().device.count()).toBe(50 - GONE_LIMIT);
    expect((await readGoneHolds()).map((h) => h.channel)).toEqual(["apns"]);
  });

  it("keeps the channels apart", async () => {
    const { forgetGoneRegistrations } =
      await import("@/lib/notifications/gone-registrations");
    const ids = await seedDevices(50);
    expect(await forgetGoneRegistrations("device", ids)).toBe(false);

    const sub = await getPrismaClient().pushSubscription.create({
      data: {
        userId: USER,
        endpoint: "https://push.example.test/1",
        p256dh: "x",
        auth: "y",
      },
    });
    expect(await forgetGoneRegistrations("webPush", [sub.id])).toBe(true);
    expect(await getPrismaClient().pushSubscription.count()).toBe(0);
  });

  it("deletes again once the hold has lapsed", async () => {
    const { forgetGoneRegistrations } =
      await import("@/lib/notifications/gone-registrations");
    const ids = await seedDevices(50);
    expect(await forgetGoneRegistrations("device", ids)).toBe(false);

    await getPrismaClient().$executeRaw`
      UPDATE rate_limits SET reset_at = (NOW() AT TIME ZONE 'UTC') - interval '1 second'
      WHERE key LIKE 'push-gone%'
    `;
    expect(await forgetGoneRegistrations("device", [ids[0]])).toBe(true);
    expect(await getPrismaClient().device.count()).toBe(49);
  });
});

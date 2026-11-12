/**
 * Integration coverage for `0497_reenable_subscribed_web_push_channels`.
 *
 * The test container starts empty, so the migration has nothing to touch when
 * it runs at boot. This seeds the states a live instance holds, applies the
 * exact migration SQL from disk, and checks which channels came back, which
 * stayed off, and that a second run changes nothing.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const MIGRATION_SQL = readFileSync(
  resolve(
    process.cwd(),
    "prisma/migrations/0497_reenable_subscribed_web_push_channels/migration.sql",
  ),
  "utf8",
);

async function seedUser(id: string, subscribed: boolean): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: { id, username: id, email: `${id}@example.test` },
  });
  if (subscribed) {
    await prisma.pushSubscription.create({
      data: {
        userId: id,
        endpoint: `https://push.example.test/${id}`,
        p256dh: "p256dh",
        auth: "auth",
      },
    });
  }
}

async function seedChannel(
  userId: string,
  type: string,
  state: { enabled: boolean; disabledReason: string | null },
): Promise<string> {
  const row = await getPrismaClient().notificationChannel.create({
    data: {
      userId,
      type,
      config: "{}",
      enabled: state.enabled,
      disabledReason: state.disabledReason,
      consecutiveFailures: 5,
      lastFailureReason: "web_push_no_subscriptions",
      nextRetryAt: state.enabled ? new Date(Date.now() + 3_600_000) : null,
    },
    select: { id: true },
  });
  return row.id;
}

function readChannel(id: string) {
  return getPrismaClient().notificationChannel.findUniqueOrThrow({
    where: { id },
    select: {
      enabled: true,
      disabledReason: true,
      consecutiveFailures: true,
      lastFailureReason: true,
      nextRetryAt: true,
      updatedAt: true,
    },
  });
}

describe("0497 re-enable subscribed Web Push channels", () => {
  beforeEach(async () => {
    await truncateAllTables(getPrismaClient());
  });

  it("turns an automatically disabled channel with a subscription back on", async () => {
    await seedUser("gone-410", true);
    await seedUser("gave-up", true);
    const gone = await seedChannel("gone-410", "WEB_PUSH", {
      enabled: false,
      disabledReason: "web_push_410_gone",
    });
    const gaveUp = await seedChannel("gave-up", "WEB_PUSH", {
      enabled: false,
      disabledReason: "give_up_after_5_failures",
    });

    await getPrismaClient().$executeRawUnsafe(MIGRATION_SQL);

    for (const id of [gone, gaveUp]) {
      expect(await readChannel(id)).toMatchObject({
        enabled: true,
        disabledReason: null,
        consecutiveFailures: 0,
        lastFailureReason: null,
        nextRetryAt: null,
      });
    }
  });

  it("leaves a channel switched off by hand, one without a subscription, and other channel types alone", async () => {
    await seedUser("by-hand", true);
    await seedUser("no-browser", false);
    await seedUser("telegram", true);
    await seedUser("healthy", true);
    const byHand = await seedChannel("by-hand", "WEB_PUSH", {
      enabled: false,
      disabledReason: null,
    });
    const noBrowser = await seedChannel("no-browser", "WEB_PUSH", {
      enabled: false,
      disabledReason: "web_push_410_gone",
    });
    const telegram = await seedChannel("telegram", "TELEGRAM", {
      enabled: false,
      disabledReason: "telegram_blocked_by_user",
    });
    const healthy = await seedChannel("healthy", "WEB_PUSH", {
      enabled: true,
      disabledReason: null,
    });
    const before = await Promise.all(
      [byHand, noBrowser, telegram, healthy].map(readChannel),
    );

    await getPrismaClient().$executeRawUnsafe(MIGRATION_SQL);

    const after = await Promise.all(
      [byHand, noBrowser, telegram, healthy].map(readChannel),
    );
    expect(after).toEqual(before);
  });

  it("changes nothing on a second run", async () => {
    await seedUser("gone-410", true);
    const id = await seedChannel("gone-410", "WEB_PUSH", {
      enabled: false,
      disabledReason: "web_push_410_gone",
    });
    await getPrismaClient().$executeRawUnsafe(MIGRATION_SQL);
    const first = await readChannel(id);

    await getPrismaClient().$executeRawUnsafe(MIGRATION_SQL);

    expect(await readChannel(id)).toEqual(first);
  });
});

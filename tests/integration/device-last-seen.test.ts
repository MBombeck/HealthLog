/**
 * #179 — the app's token stamps its own device's `lastSeen`.
 *
 * The device is the one the token's refresh family names
 * (`RefreshToken.accessTokenHash` = the token's hash, `deviceId` = the
 * `Device.token` the app registered). At most once an hour, never another
 * account's device, never a device the token is not linked to.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  resetDeviceLastSeenThrottle,
  stampDeviceLastSeen,
} from "@/lib/auth/device-last-seen";

import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();
const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 17, 8, 0, 0);
const OLD = new Date(NOW - 3 * HOUR);

async function seed(): Promise<void> {
  for (const id of ["user-a", "user-b"]) {
    await prisma.user.create({
      data: { id, username: id, role: "USER", timezone: "UTC" },
    });
  }
  for (const [id, userId, token] of [
    ["dev-phone", "user-a", "phone-token"],
    ["dev-pad", "user-a", "pad-token"],
    ["dev-other", "user-b", "phone-token-b"],
  ] as const) {
    await prisma.device.create({
      data: {
        id,
        userId,
        platform: "ios",
        token,
        bundleId: "app",
        lastSeen: OLD,
      },
    });
  }
  await prisma.apiToken.create({
    data: {
      id: "tok-phone",
      userId: "user-a",
      name: "iPhone",
      tokenHash: "hash-access-phone",
      permissions: ["*"],
    },
  });
  await prisma.apiToken.create({
    data: {
      id: "tok-unlinked",
      userId: "user-a",
      name: "script",
      tokenHash: "hash-access-unlinked",
      permissions: ["*"],
    },
  });
  await prisma.refreshToken.create({
    data: {
      userId: "user-a",
      tokenHash: "hash-refresh-phone",
      accessTokenHash: "hash-access-phone",
      deviceId: "phone-token",
      expiresAt: new Date(NOW + 30 * 24 * HOUR),
    },
  });
}

async function lastSeen(id: string): Promise<number> {
  const row = await prisma.device.findUniqueOrThrow({ where: { id } });
  return row.lastSeen.getTime();
}

/** The stamp is fire-and-forget; wait until the write has landed or not. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 150));
}

beforeEach(async () => {
  await truncateAllTables(prisma);
  resetDeviceLastSeenThrottle();
  await seed();
});

describe("device lastSeen on use", () => {
  it("stamps the device the token's refresh family names, and only it", async () => {
    stampDeviceLastSeen("user-a", "tok-phone", NOW);
    await settle();
    expect(await lastSeen("dev-phone")).toBe(NOW);
    expect(await lastSeen("dev-pad")).toBe(OLD.getTime());
    expect(await lastSeen("dev-other")).toBe(OLD.getTime());
  });

  it("does not move a device seen within the hour, even from another instance", async () => {
    await prisma.device.update({
      where: { id: "dev-phone" },
      data: { lastSeen: new Date(NOW - 30 * 60 * 1000) },
    });
    // A fresh throttle stands in for a second instance that never stamped.
    stampDeviceLastSeen("user-a", "tok-phone", NOW);
    await settle();
    expect(await lastSeen("dev-phone")).toBe(NOW - 30 * 60 * 1000);
  });

  it("leaves every device alone for a token with no device link", async () => {
    stampDeviceLastSeen("user-a", "tok-unlinked", NOW);
    await settle();
    for (const id of ["dev-phone", "dev-pad", "dev-other"]) {
      expect(await lastSeen(id)).toBe(OLD.getTime());
    }
  });

  it("never crosses accounts, whatever user id it is handed", async () => {
    stampDeviceLastSeen("user-b", "tok-phone", NOW);
    await settle();
    expect(await lastSeen("dev-phone")).toBe(OLD.getTime());
    expect(await lastSeen("dev-other")).toBe(OLD.getTime());
  });
});

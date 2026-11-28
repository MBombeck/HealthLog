/**
 * `GET /api/integrations/overview` against a real database.
 *
 * The unit suite pins the resolver; this pins the loader and the route: which
 * stored facts make a row "set up", which channel row reads which status, and
 * that the answer carries every source and every channel in display order.
 * Everything below the auth cookie is real: the handler, the shared
 * connection-health loader and Postgres.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

import { GET } from "@/app/api/integrations/overview/route";
import {
  OVERVIEW_CHANNEL_KEYS,
  OVERVIEW_SOURCE_KEYS,
  type IntegrationOverview,
  type IntegrationOverviewItem,
} from "@/lib/integrations/overview";

let userId: string;

beforeEach(async () => {
  const db = getPrismaClient();
  await truncateAllTables(db);
  cookieJar.clear();
  const user = await db.user.create({
    data: {
      username: "overview-test",
      email: "overview@example.test",
      role: "USER",
    },
  });
  userId = user.id;
  const session = await db.session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
});

async function read(): Promise<IntegrationOverviewItem[]> {
  const res = await GET();
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: IntegrationOverview };
  return body.data.items;
}

function find(items: IntegrationOverviewItem[], key: string) {
  const item = items.find((i) => i.key === key);
  expect(item, key).toBeDefined();
  return item!;
}

describe("GET /api/integrations/overview", () => {
  it("answers 401 without a session", async () => {
    cookieJar.clear();
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("lists every source, then every channel, none set up on a new account", async () => {
    const items = await read();
    expect(items.map((i) => i.key)).toEqual([
      ...OVERVIEW_SOURCE_KEYS,
      ...OVERVIEW_CHANNEL_KEYS,
    ]);
    for (const item of items) {
      expect(item.setUp, item.key).toBe(false);
      expect(item.status, item.key).toBeNull();
    }
    // Withings needs the person's own app credentials before it connects.
    expect(find(items, "withings").setupNote).toBe("own_credentials");
    // The iPhone app's channel is set up by the app, never offered here.
    expect(find(items, "apns").offered).toBe(false);
  });

  it("reads stored credentials without a connection as off, not connected", async () => {
    await getPrismaClient().user.update({
      where: { id: userId },
      data: {
        withingsClientIdEncrypted: "sealed-id",
        withingsClientSecretEncrypted: "sealed-secret",
      },
    });
    expect(find(await read(), "withings")).toMatchObject({
      setUp: true,
      status: "off",
      reason: "not_connected",
      setupNote: null,
    });
  });

  it("reads each channel row from the dispatcher's reliability fields", async () => {
    const db = getPrismaClient();
    const delivered = new Date(Date.now() - 60 * 60 * 1000);
    await db.notificationChannel.createMany({
      data: [
        {
          userId,
          type: "TELEGRAM",
          config: "sealed",
          enabled: true,
          lastSuccessAt: delivered,
        },
        { userId, type: "NTFY", config: "sealed", enabled: false },
        {
          userId,
          type: "WEBHOOK",
          config: "sealed",
          enabled: false,
          disabledReason: "hard_reject_410",
        },
        {
          userId,
          type: "EMAIL",
          config: "sealed",
          enabled: true,
          nextRetryAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      ],
    });
    const items = await read();
    expect(find(items, "telegram")).toMatchObject({
      setUp: true,
      status: "active",
      reason: null,
      lastAt: delivered.toISOString(),
    });
    expect(find(items, "ntfy")).toMatchObject({
      status: "off",
      reason: "switched_off",
    });
    expect(find(items, "webhook")).toMatchObject({
      status: "error",
      reason: "auto_disabled",
    });
    expect(find(items, "email")).toMatchObject({
      status: "error",
      reason: "sending_paused",
    });
    expect(find(items, "web-push").setUp).toBe(false);
  });

  it("reads a paused Health Connect folder as off", async () => {
    await getPrismaClient().healthConnectRemoteSource.create({
      data: {
        userId,
        folderUrl: "https://cloud.example.test/remote.php/dav/files/u/hc",
        credentialsEncrypted: "sealed",
        enabled: false,
      },
    });
    expect(find(await read(), "health-connect-remote")).toMatchObject({
      setUp: true,
      status: "off",
      reason: "paused",
    });
  });
});

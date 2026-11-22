/**
 * The operator insights Admin shows on the running server: the database
 * migrations against the image, and what the instance handed the push relay.
 *
 * - `GET /api/admin/migrations` compares the shipped `prisma/migrations`
 *   folder with `_prisma_migrations` as the database really holds it: on a
 *   migrated test database every shipped migration is applied and none is
 *   pending, and a row that started and never finished reads as failed.
 * - `GET /api/admin/push-relay` counts the relay delivery ledger of the last
 *   seven days per outcome, aggregate only, and names the last failure; an
 *   older row is outside the window. The relay question is answered once
 *   the relay is on.
 * - Both are admin-only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { callRoute } from "../kit/call-route";
import { makeSession, makeUser } from "../kit/factories";
import { bindDevice, enableRelay } from "./push-relay-kit";

const prisma = getPrismaClient();

beforeEach(async () => {
  vi.stubEnv("PUSH_RELAY_URL", RELAY_URL);
  vi.stubEnv("PUSH_RELAY_KEYS", RELAY_PUBLIC_KEY);
  await truncateAllTables(prisma);
  relay.current = new FakeRelay();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

interface MigrationStatus {
  shipped: number | null;
  applied: number;
  pending: number;
  pendingNames: string[];
  failedNames: string[];
  lastApplied: { name: string; at: string } | null;
}

describe("GET /api/admin/migrations", () => {
  it("reads the migrated database as up to date with the image", async () => {
    const { GET } = await import("@/app/api/admin/migrations/route");
    const { adminSession } = await enableRelay();
    const res = await callRoute<MigrationStatus>(GET, {
      method: "GET",
      route: "/api/admin/migrations",
      auth: adminSession,
    });
    expect(res.status).toBe(200);
    expect(res.data.shipped).toBeGreaterThan(100);
    expect(res.data.pending).toBe(0);
    expect(res.data.failedNames).toEqual([]);
    expect(res.data.applied).toBeGreaterThanOrEqual(res.data.shipped ?? 0);
    expect(res.data.lastApplied?.name).toMatch(/^\d{4}_/);
  });

  it("reports a migration that started and did not finish", async () => {
    const { GET } = await import("@/app/api/admin/migrations/route");
    const { adminSession } = await enableRelay();
    const name = "9999_left_half_done";
    await prisma.$executeRaw`
      INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, applied_steps_count)
      VALUES (${`test-${Date.now()}`}, 'x', ${name}, now(), 0)
    `;
    try {
      const res = await callRoute<MigrationStatus>(GET, {
        method: "GET",
        route: "/api/admin/migrations",
        auth: adminSession,
      });
      expect(res.data.failedNames).toContain(name);
    } finally {
      await prisma.$executeRaw`DELETE FROM _prisma_migrations WHERE migration_name = ${name}`;
    }
  });

  it("refuses everyone but an admin", async () => {
    const { GET } = await import("@/app/api/admin/migrations/route");
    const res = await callRoute(GET, {
      method: "GET",
      route: "/api/admin/migrations",
      auth: await makeSession(await makeUser()),
    });
    expect(res.status).toBe(403);
  });
});

interface RelayStatus {
  offered: boolean;
  operatorDecision: string;
  usage: {
    windowDays: number;
    accepted: number;
    pending: number;
    dropped: number;
    failed: number;
    lastFailure: { reason: string | null; at: string } | null;
  };
}

describe("GET /api/admin/push-relay usage", () => {
  it("counts the ledger of the window per outcome and names the last failure", async () => {
    const { GET } = await import("@/app/api/admin/push-relay/route");
    const { instanceId, adminSession } = await enableRelay();
    const { deviceId } = await bindDevice(instanceId, "a".repeat(64));
    const now = Date.now();
    const row = (
      ref: string,
      status: string,
      ageDays: number,
      reason: string | null = null,
    ) => ({
      deviceId,
      ref,
      pushClass: "alert",
      eventType: "MEDICATION_REMINDER",
      expiresAt: new Date(now + 3_600_000),
      status,
      reason,
      createdAt: new Date(now - ageDays * 86_400_000),
    });
    await prisma.pushRelayDelivery.createMany({
      data: [
        row("r1", "accepted", 1),
        row("r2", "accepted", 2),
        row("r3", "pending", 0),
        row("r4", "failed", 3, "relay_unavailable"),
        row("r5", "dropped", 1, "BadDeviceToken"),
        // Outside the seven days.
        row("r6", "failed", 9, "old"),
      ],
    });

    const res = await callRoute<RelayStatus>(GET, {
      method: "GET",
      route: "/api/admin/push-relay",
      auth: adminSession,
    });
    expect(res.status).toBe(200);
    expect(res.data.offered).toBe(true);
    expect(res.data.usage).toMatchObject({
      windowDays: 7,
      accepted: 2,
      pending: 1,
      dropped: 1,
      failed: 1,
    });
    expect(res.data.usage.lastFailure?.reason).toBe("BadDeviceToken");
    // The relay is on, so the relay question is answered.
    expect(res.data.operatorDecision).toBe("on");
  });
});

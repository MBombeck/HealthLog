/**
 * The demo refresh deletes every account in the database it runs against and
 * rewrites the demo from the seed. These tests hold the fences around that:
 * outside `DEMO_MODE=true` the queue is not declared and the handler and the
 * boot discovery do nothing, and even on a demo deploy it runs only against a
 * database that holds the demo account alone.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";

const send = vi.fn(async () => "job-id");
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({ send }),
}));

import {
  DEMO_REFRESH_CRON,
  DEMO_REFRESH_QUEUE,
  demoRefreshEnabled,
} from "@/lib/jobs/demo-refresh-queue";
import {
  enqueueBootTimeDemoRefresh,
  handleDemoRefresh,
  refreshCutToday,
} from "@/lib/jobs/demo-refresh";
import { allJobDefinitions } from "@/lib/jobs/registry";
import { maintenanceDemoJobs } from "@/lib/jobs/registry/maintenance-demo";

function fakePrisma(
  usernames: string[],
  createdAt: Date = new Date(0),
): PrismaClient & { $queryRaw: ReturnType<typeof vi.fn> } {
  const $queryRaw = vi.fn(async (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    if (sql.includes("created_at")) return [{ createdAt }];
    return usernames.map((username) => ({ username }));
  });
  return { $queryRaw } as unknown as PrismaClient & {
    $queryRaw: ReturnType<typeof vi.fn>;
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  send.mockClear();
});

describe("demo refresh outside demo mode", () => {
  it.each([undefined, "", "false", "1", "TRUE"])(
    "is off for DEMO_MODE=%s",
    (value) => {
      if (value === undefined) vi.stubEnv("DEMO_MODE", undefined);
      else vi.stubEnv("DEMO_MODE", value);
      expect(demoRefreshEnabled()).toBe(false);
      expect(maintenanceDemoJobs()).toEqual([]);
    },
  );

  it("is not in the worker registry", () => {
    // The registry is built at import, under the test env, which is not a
    // demo deploy.
    expect(process.env.DEMO_MODE).not.toBe("true");
    const queues = allJobDefinitions().map((d) => d.queue);
    expect(queues).not.toContain(DEMO_REFRESH_QUEUE);
  });

  it("the handler neither reads the database nor seeds", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    const prisma = fakePrisma(["demo"]);
    const seed = vi.fn();
    const afterSeed = vi.fn();
    const outcome = await handleDemoRefresh([], { prisma, seed, afterSeed });
    expect(outcome).toEqual({ ok: true, did: { skipped: true } });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(seed).not.toHaveBeenCalled();
    expect(afterSeed).not.toHaveBeenCalled();
  });

  it("the boot discovery sends nothing", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    const prisma = fakePrisma(["demo"]);
    const result = await enqueueBootTimeDemoRefresh(
      prisma,
      new Date("2026-11-24T15:00:00Z"),
    );
    expect(result).toEqual({ enqueued: false, error: null });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("demo refresh on a demo deploy", () => {
  it("declares the queue with its daily cron", () => {
    vi.stubEnv("DEMO_MODE", "true");
    const jobs = maintenanceDemoJobs();
    expect(jobs.map((j) => [j.queue, j.cron])).toEqual([
      [DEMO_REFRESH_QUEUE, DEMO_REFRESH_CRON],
    ]);
    expect(DEMO_REFRESH_CRON).toBe("0 10 * * *");
  });

  it("refuses a database that holds any account besides the demo", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    for (const names of [[], ["alice"], ["demo", "alice"]]) {
      const seed = vi.fn();
      const outcome = await handleDemoRefresh([], {
        prisma: fakePrisma(names),
        seed,
        afterSeed: vi.fn(),
        databaseUrl: "postgresql://unused@127.0.0.1:1/none",
      });
      expect(outcome).toEqual({ ok: true, did: { skipped: true } });
      expect(seed).not.toHaveBeenCalled();
    }
  });

  it("seeds, then runs the boot discovery", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const order: string[] = [];
    const outcome = await handleDemoRefresh([], {
      prisma: fakePrisma(["demo"]),
      seed: async () => {
        order.push("seed");
      },
      afterSeed: async () => {
        order.push("discovery");
      },
      databaseUrl: "postgresql://unused@127.0.0.1:1/none",
    });
    expect(outcome).toEqual({ ok: true, did: { accounts_completed: 1 } });
    expect(order).toEqual(["seed", "discovery"]);
  });

  it("reports a failed seed as a failed job", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const afterSeed = vi.fn();
    const outcome = await handleDemoRefresh([], {
      prisma: fakePrisma(["demo"]),
      seed: async () => {
        throw new Error("boom");
      },
      afterSeed,
      databaseUrl: "postgresql://unused@127.0.0.1:1/none",
    });
    expect(outcome).toMatchObject({ ok: false });
    expect(afterSeed).not.toHaveBeenCalled();
  });
});

describe("demo refresh boot discovery", () => {
  // 24 Nov 2026 is winter time: 10:00 Berlin is 09:00 UTC.
  const cut = new Date("2026-11-24T09:00:00Z");

  it("waits for the cron before the refresh hour", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const now = new Date("2026-11-24T08:59:00Z");
    expect(refreshCutToday(now)).toBeNull();
    const result = await enqueueBootTimeDemoRefresh(fakePrisma(["demo"]), now);
    expect(result.enqueued).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("refreshes a demo seeded before today's refresh hour", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const now = new Date("2026-11-24T15:00:00Z");
    expect(refreshCutToday(now)?.toISOString()).toBe(cut.toISOString());
    const result = await enqueueBootTimeDemoRefresh(
      fakePrisma(["demo"], new Date("2026-11-18T09:30:00Z")),
      now,
    );
    expect(result).toEqual({ enqueued: true, error: null });
    expect(send).toHaveBeenCalledWith(
      DEMO_REFRESH_QUEUE,
      {},
      expect.objectContaining({ singletonKey: "demo-refresh" }),
    );
  });

  it("leaves a demo seeded after today's refresh hour alone", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const result = await enqueueBootTimeDemoRefresh(
      fakePrisma(["demo"], new Date("2026-11-24T09:00:05Z")),
      new Date("2026-11-24T15:00:00Z"),
    );
    expect(result.enqueued).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("never sends for a database with other accounts", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const result = await enqueueBootTimeDemoRefresh(
      fakePrisma(["demo", "alice"]),
      new Date("2026-11-24T15:00:00Z"),
    );
    expect(result.enqueued).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

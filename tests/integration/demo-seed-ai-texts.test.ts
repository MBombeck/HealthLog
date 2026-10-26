/**
 * The demo seed bakes model-written text into the same rows a generation
 * writes, because the public demo has no live provider. That only works if
 * the seed writes exactly what the readers expect: a payload without its
 * `briefingGeneratedAt` stamp reads as text of unknown age, and every
 * briefing surface then serves nothing while a "today" timestamp sits on
 * the page.
 *
 * This runs the real `scripts/seed-demo.ts` against the test database and
 * reads its output back through the app's own readers: the advisor briefing
 * behind the `/insights` card and hero, the dashboard snapshot headline, the
 * per-metric status cards and the period narratives.
 */
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

// A warm on the demo can only fail against the seeded placeholder key, so a
// fresh seed must not ask for one.
const enqueueForceWarm = vi.fn();
vi.mock("@/lib/jobs/insight-pregenerate-shared", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/jobs/insight-pregenerate-shared")
  >()),
  enqueueForceWarm: (...args: unknown[]) => enqueueForceWarm(...args),
}));

let userId: string;

beforeAll(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  cookieJar.clear();
  headerJar.clear();
  const { seed } = await import("../../scripts/seed-demo");
  await seed();
  const user = await prisma.user.findUniqueOrThrow({
    where: { username: "demo" },
    select: { id: true },
  });
  userId = user.id;
}, 180_000);

afterAll(() => {
  vi.restoreAllMocks();
});

describe("demo seed, baked AI texts read back through the app", () => {
  it("serves today's briefing on the advisor read, with no warm asked for", async () => {
    const { readAdvisorBriefing } =
      await import("@/lib/insights/briefing-request/read");

    const read = await readAdvisorBriefing({
      request: new NextRequest("http://localhost/api/insights/generate"),
      userId,
      userLocale: "en",
    });

    const briefing = (read.insights as Record<string, unknown> | null)
      ?.dailyBriefing as {
      paragraph: string;
      keyFindings: unknown[];
      signalsOfDay?: Array<{ sourceMetric: string }>;
    } | null;
    expect(briefing).not.toBeNull();
    expect(briefing?.paragraph).toMatch(/^Today's picture is a calm one/);
    expect(briefing?.keyFindings).toHaveLength(4);
    // Sleep rests on no single dated reading, so it is kept whatever the
    // hour; the reading-backed signals follow today's seeded readings.
    expect(briefing?.signalsOfDay?.map((s) => s.sourceMetric)).toContain(
      "sleep",
    );
    expect(read.revalidating).toBe(false);
    expect(enqueueForceWarm).not.toHaveBeenCalled();
  });

  it("serves the same briefing as the dashboard headline", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const { readDashboardSnapshotCached } =
      await import("@/lib/dashboard/snapshot-read");

    const { body, locale } = await readDashboardSnapshotCached(user);

    expect(locale).toBe("en");
    expect(body.briefingState).toBe("ready");
    expect(body.briefing?.paragraph).toMatch(/^Today's picture is a calm one/);
  });

  it("serves every baked status card as today's note", async () => {
    const { readFreshStatusText, statusCacheAction } =
      await import("@/lib/insights/status-cache");
    const { userDayKey } = await import("@/lib/tz/format");
    const todayKey = userDayKey(new Date(), "Europe/Berlin");

    for (const scope of [
      "blood-pressure",
      "pulse",
      "weight",
      "bmi",
      "mood",
      "medication-compliance",
      "general",
    ]) {
      const hit = await readFreshStatusText({
        userId,
        cacheAction: statusCacheAction(scope, "en"),
        todayKey,
        force: false,
      });
      expect(hit?.text, scope).toBeTruthy();
    }
  });

  it("serves both baked period narratives", async () => {
    const { readPeriodNarrative } =
      await import("@/lib/insights/narrative/period-narrative-generate");

    for (const period of ["week", "month"] as const) {
      const read = await readPeriodNarrative(userId, period, "en");
      expect(read?.text, period).toBeTruthy();
    }
  });
});

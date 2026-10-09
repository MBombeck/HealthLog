/**
 * Concurrent writes to one account's dashboard layout blob.
 *
 * `PUT /api/dashboard/chart-overlay-prefs` read-modifies-writes
 * `User.dashboardWidgetsJson`. It used to do so in a Serializable
 * transaction, which kept parallel toggles from clobbering one another by
 * aborting all but one with a serialization failure, and every aborted one
 * answered 500. A row lock queues them instead: every request succeeds, and
 * the stored layout holds every toggle, because each writer reads after the
 * previous one committed. A reset (`DELETE /api/dashboard/widgets`) racing
 * the toggles takes the same lock and keeps the per-chart preferences.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { CHART_OVERLAY_KEYS } from "@/lib/dashboard-layout";

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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedUser(): Promise<{ userId: string }> {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "chart-overlay-race-user",
      email: "chart-overlay-race@example.test",
      role: "USER",
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
  return { userId: user.id };
}

type Handler = (req: Request) => Promise<Response>;

function put(chartKey: string, showTrendArrow: boolean) {
  return new Request("http://localhost/api/dashboard/chart-overlay-prefs", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chartKey,
      prefs: {
        showTrendIndicator: true,
        showTrendArrow,
        showTargetRange: false,
        comparisonBaseline: "none",
      },
    }),
  });
}

async function storedPrefs(userId: string) {
  const row = await getPrismaClient().user.findUniqueOrThrow({
    where: { id: userId },
    select: { dashboardWidgetsJson: true },
  });
  const layout = row.dashboardWidgetsJson as {
    chartOverlayPrefs?: Record<string, { showTrendArrow: boolean }>;
  } | null;
  return layout?.chartOverlayPrefs ?? {};
}

describe("concurrent chart-overlay writes from one account", () => {
  it("answers 200 to every parallel PUT and keeps every chart's toggle", async () => {
    const { userId } = await seedUser();
    const { PUT } =
      await import("@/app/api/dashboard/chart-overlay-prefs/route");
    const keys = CHART_OVERLAY_KEYS.slice(0, 8);
    expect(keys.length).toBe(8);

    const responses = await Promise.all(
      keys.map((key) => (PUT as Handler)(put(key, true))),
    );
    expect(responses.map((res) => res.status)).toEqual(keys.map(() => 200));

    const prefs = await storedPrefs(userId);
    for (const key of keys) {
      expect(prefs[key]?.showTrendArrow, key).toBe(true);
    }
  });

  it("settles parallel writes to the same chart on one of the written values", async () => {
    const { userId } = await seedUser();
    const { PUT } =
      await import("@/app/api/dashboard/chart-overlay-prefs/route");
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (PUT as Handler)(put("weight", i % 2 === 0)),
      ),
    );
    expect(responses.map((res) => res.status)).toEqual(
      Array.from({ length: 10 }, () => 200),
    );
    const prefs = await storedPrefs(userId);
    expect(typeof prefs.weight?.showTrendArrow).toBe("boolean");
  });

  it("keeps every toggle when a layout reset races them", async () => {
    const { userId } = await seedUser();
    const { PUT } =
      await import("@/app/api/dashboard/chart-overlay-prefs/route");
    const { DELETE } = await import("@/app/api/dashboard/widgets/route");
    const keys = CHART_OVERLAY_KEYS.slice(0, 6);

    const responses = await Promise.all([
      ...keys.map((key) => (PUT as Handler)(put(key, true))),
      (DELETE as Handler)(
        new Request("http://localhost/api/dashboard/widgets", {
          method: "DELETE",
        }),
      ),
    ]);
    expect(responses.map((res) => res.status)).toEqual(
      responses.map(() => 200),
    );

    const prefs = await storedPrefs(userId);
    for (const key of keys) {
      expect(prefs[key]?.showTrendArrow, key).toBe(true);
    }
  });
});

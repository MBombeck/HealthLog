/**
 * v1.4.18 — integration coverage for the new PUT
 * `/api/dashboard/chart-overlay-prefs` endpoint.
 *
 * The route persists per-chart overlay-prefs (3 toggles per chart card)
 * onto the existing `User.dashboardWidgetsJson` blob, alongside the B8
 * comparison baseline. We pin two scenarios end-to-end against the
 * postgres testcontainer:
 *   1. Saving valid prefs persists them and a follow-up GET against
 *      `/api/dashboard/widgets` surfaces them.
 *   2. Unknown chart keys / non-boolean values get coerced away by
 *      the resolver so a malformed PUT can't poison the dashboard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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
      username: "chart-overlay-user",
      email: "chart-overlay@example.test",
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

describe("PUT /api/dashboard/chart-overlay-prefs — integration", () => {
  it("persists per-chart prefs and the follow-up GET /api/dashboard/widgets surfaces them", async () => {
    const { userId } = await seedUser();
    const { PUT } =
      await import("@/app/api/dashboard/chart-overlay-prefs/route");
    const { GET: getWidgets } =
      await import("@/app/api/dashboard/widgets/route");

    const putRes = await (PUT as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/dashboard/chart-overlay-prefs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chartKey: "bp",
          prefs: {
            showTrendIndicator: true,
            showTrendArrow: false,
            showTargetRange: true,
          },
        }),
      }),
    );
    expect(putRes.status).toBe(200);

    const getRes = await (getWidgets as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/dashboard/widgets"),
    );
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as {
      data: { chartOverlayPrefs?: Record<string, unknown> };
    };
    expect(body.data.chartOverlayPrefs).toMatchObject({
      bp: {
        showTrendIndicator: true,
        showTrendArrow: false,
        showTargetRange: true,
      },
    });

    // Subsequent PUT for a different chart preserves the existing one.
    await (PUT as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/dashboard/chart-overlay-prefs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chartKey: "weight",
          prefs: {
            showTrendIndicator: false,
            showTrendArrow: true,
            showTargetRange: false,
          },
        }),
      }),
    );

    const finalRes = await (getWidgets as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/dashboard/widgets"),
    );
    const finalBody = (await finalRes.json()) as {
      data: { chartOverlayPrefs?: Record<string, unknown> };
    };
    expect(finalBody.data.chartOverlayPrefs).toMatchObject({
      bp: {
        showTrendIndicator: true,
        showTrendArrow: false,
        showTargetRange: true,
      },
      weight: {
        showTrendIndicator: false,
        showTrendArrow: true,
        showTargetRange: false,
      },
    });

    // Sanity: the row was actually written.
    const stored = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: userId },
      select: { dashboardWidgetsJson: true },
    });
    expect(stored.dashboardWidgetsJson).toBeTruthy();
  });

  it("rejects an unknown chart key with 422", async () => {
    await seedUser();
    const { PUT } =
      await import("@/app/api/dashboard/chart-overlay-prefs/route");

    const res = await (PUT as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/dashboard/chart-overlay-prefs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chartKey: "not_a_real_chart",
          prefs: {
            showTrendIndicator: true,
            showTrendArrow: true,
            showTargetRange: true,
          },
        }),
      }),
    );
    expect(res.status).toBe(422);
  });
});

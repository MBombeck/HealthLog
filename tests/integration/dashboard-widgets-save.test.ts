/**
 * v1.4.25 W6 — integration coverage for the PUT
 * `/api/dashboard/widgets` endpoint with realistic full-layout payloads.
 *
 * Root-cause this suite pins:
 *   Settings → Dashboard's Save button stopped persisting once the user
 *   had touched any per-chart overlay popover. The widgets-route Zod
 *   schema used `z.record(z.enum(CHART_OVERLAY_KEYS), …)` which under
 *   Zod v4 demands every enum key to be present. Real-world payloads
 *   carry one or two chart keys (the ones the user actually flipped),
 *   so every Save click 422'd with
 *   `expected: object, path: ["chartOverlayPrefs", "<missing-key>"]`
 *   and the toast surfaced "Layout konnte nicht gespeichert werden".
 *
 * The fix switched to `z.partialRecord(...)` so partial maps round-trip
 * cleanly. We exercise:
 *   1. Full layout with a single `chartOverlayPrefs` entry persists.
 *   2. Per-chart `comparisonBaseline` survives a Settings save (the
 *      previous schema silently stripped it).
 *   3. Empty `chartOverlayPrefs` still persists (parity with fresh
 *      accounts that have never opened a chart popover).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { DEFAULT_DASHBOARD_LAYOUT } from "@/lib/dashboard-layout";

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
      username: "dashboard-save-user",
      email: "dashboard-save@example.test",
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

function buildClientPayload(
  overrides: Partial<{
    chartOverlayPrefs: Record<string, unknown>;
  }>,
) {
  return {
    version: 1,
    widgets: DEFAULT_DASHBOARD_LAYOUT.widgets.map((w) => ({
      id: w.id,
      visible: w.visible,
      tileVisible: w.tileVisible ?? w.visible,
      order: w.order,
    })),
    comparisonBaseline: "none" as const,
    ...overrides,
  };
}

describe("PUT /api/dashboard/widgets — Save persists full layouts", () => {
  it("accepts a partial chartOverlayPrefs map (single chart key)", async () => {
    const { userId } = await seedUser();
    const { PUT, GET } = await import("@/app/api/dashboard/widgets/route");

    // Realistic Save click: the user flipped the weight chart's tile
    // toggle from Settings → Dashboard. The cached layout has a single
    // per-chart entry (the BP chart popover the user opened earlier).
    const body = buildClientPayload({
      chartOverlayPrefs: {
        bp: {
          showTrendIndicator: true,
          showTrendArrow: false,
          showTargetRange: false,
          comparisonBaseline: "lastMonth",
        },
      },
    });

    const putRes = await (PUT as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/dashboard/widgets", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect(putRes.status).toBe(200);

    // Sanity: the row actually landed in the DB.
    const stored = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: userId },
      select: { dashboardWidgetsJson: true },
    });
    expect(stored.dashboardWidgetsJson).toBeTruthy();

    // Follow-up GET surfaces the saved per-chart prefs end-to-end.
    const getRes = await (GET as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/dashboard/widgets"),
    );
    const getBody = (await getRes.json()) as {
      data: { chartOverlayPrefs?: Record<string, unknown> };
    };
    expect(getBody.data.chartOverlayPrefs).toMatchObject({
      bp: {
        showTrendIndicator: true,
        showTrendArrow: false,
        showTargetRange: false,
      },
    });
  });

  it("preserves per-chart comparisonBaseline through a Settings save", async () => {
    const { userId } = await seedUser();
    const { PUT, GET } = await import("@/app/api/dashboard/widgets/route");

    // Step 1: the user set the BP chart's comparisonBaseline = lastMonth
    // via the chart popover. Seed it directly to skip the popover route.
    const seededLayout = {
      version: 1,
      widgets: DEFAULT_DASHBOARD_LAYOUT.widgets,
      comparisonBaseline: "none",
      chartOverlayPrefs: {
        bp: {
          showTrendIndicator: false,
          showTrendArrow: false,
          showTargetRange: false,
          comparisonBaseline: "lastMonth",
        },
      },
    };
    await getPrismaClient().user.update({
      where: { id: userId },
      data: {
        dashboardWidgetsJson: seededLayout as never,
      },
    });

    // Step 2: the user opens Settings → Dashboard and clicks Save.
    // The client posts back the layout it loaded — including the BP
    // chart's `comparisonBaseline: "lastMonth"` (which the resolver
    // re-emits on every GET).
    const putBody = {
      version: 1,
      widgets: seededLayout.widgets,
      comparisonBaseline: "none",
      chartOverlayPrefs: {
        bp: {
          showTrendIndicator: false,
          showTrendArrow: false,
          showTargetRange: false,
          comparisonBaseline: "lastMonth",
        },
      },
    };
    const putRes = await (PUT as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/dashboard/widgets", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(putBody),
      }),
    );
    expect(putRes.status).toBe(200);

    // Step 3: GET — the per-chart comparisonBaseline must still be
    // "lastMonth". With the previous `z.record(enum, …)` schema, Zod
    // would either reject the save outright (incomplete record) OR
    // strip the `comparisonBaseline` field, both of which wiped the
    // user's per-chart toggle.
    const getRes = await (GET as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/dashboard/widgets"),
    );
    const getBody = (await getRes.json()) as {
      data: {
        chartOverlayPrefs?: Record<string, { comparisonBaseline?: string }>;
      };
    };
    expect(getBody.data.chartOverlayPrefs?.bp?.comparisonBaseline).toBe(
      "lastMonth",
    );
  });

  it("accepts an empty chartOverlayPrefs map (fresh account)", async () => {
    await seedUser();
    const { PUT } = await import("@/app/api/dashboard/widgets/route");

    const body = buildClientPayload({ chartOverlayPrefs: {} });
    const res = await (PUT as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/dashboard/widgets", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("widget toggle changes round-trip end-to-end", async () => {
    const { userId } = await seedUser();
    const { PUT, GET } = await import("@/app/api/dashboard/widgets/route");

    // Marc flips the sleep widget's chart visibility on.
    const body = buildClientPayload({
      chartOverlayPrefs: {
        bp: {
          showTrendIndicator: true,
          showTrendArrow: false,
          showTargetRange: true,
        },
      },
    });
    body.widgets = body.widgets.map((w) =>
      w.id === "sleep" ? { ...w, visible: true, tileVisible: true } : w,
    );

    const putRes = await (PUT as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/dashboard/widgets", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect(putRes.status).toBe(200);

    const getRes = await (GET as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/dashboard/widgets"),
    );
    const getBody = (await getRes.json()) as {
      data: {
        widgets: Array<{ id: string; visible: boolean; tileVisible?: boolean }>;
      };
    };
    const sleep = getBody.data.widgets.find((w) => w.id === "sleep");
    expect(sleep?.visible).toBe(true);
    expect(sleep?.tileVisible).toBe(true);

    // DB row writes through.
    const stored = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: userId },
      select: { dashboardWidgetsJson: true },
    });
    expect(stored.dashboardWidgetsJson).toBeTruthy();
  });
});

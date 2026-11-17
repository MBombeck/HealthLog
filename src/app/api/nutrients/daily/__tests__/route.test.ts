/**
 * v1.29 — `GET /api/nutrients/daily` contract tests.
 *
 * Pins the per-day-bucketed series feeding the hydration/caffeine
 * charts: module gate, query validation, the dense (zero-filled) day
 * range, summing across sources within a day, and the sex-resolved
 * (or omitted) EFSA reference.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    nutrientIntakeDay: {
      findMany: vi.fn(),
    },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { apiError } from "@/lib/api-response";
import { getSession } from "@/lib/auth/session";
import { requireModuleEnabled } from "@/lib/modules/gate";

function sessionFor(gender: string | null) {
  return {
    session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
    user: {
      id: "user-1",
      username: "tester",
      role: "USER" as const,
      timezone: "Europe/Berlin",
      gender,
    },
  };
}

function getReq(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/nutrients/daily${query}`);
}

interface DailyResponse {
  data: {
    nutrient: string;
    unit: string;
    windowDays: number;
    days: Array<{ day: string; amount: number }>;
    reference: { kind: string; direction: string; value: number } | null;
    personalTarget: { value: number; direction: string } | null;
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(sessionFor("FEMALE") as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true } as never);
  vi.mocked(prisma.nutrientIntakeDay.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    nutrientTargetsJson: null,
  } as never);
});

describe("GET /api/nutrients/daily", () => {
  it("refuses with the 403 module.disabled envelope when the module is off", async () => {
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: false,
      response: apiError('Module "nutrients" is not enabled', 403, {
        errorCode: "module.disabled",
        module: "nutrients",
      }),
    } as never);
    const res = await GET(getReq("?nutrient=water&days=30"));
    expect(res.status).toBe(403);
    expect(prisma.nutrientIntakeDay.findMany).not.toHaveBeenCalled();
  });

  it("rejects an unknown nutrient code with 422", async () => {
    const res = await GET(getReq("?nutrient=not-a-code&days=30"));
    expect(res.status).toBe(422);
  });

  it("rejects an out-of-range days value with 422", async () => {
    for (const bad of ["0", "91", "abc"]) {
      const res = await GET(getReq(`?nutrient=water&days=${bad}`));
      expect(res.status, `days=${bad}`).toBe(422);
    }
  });

  it("defaults to a 30-day dense window with zero-filled days for a fresh account", async () => {
    const res = await GET(getReq("?nutrient=water"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as DailyResponse;
    expect(body.data.windowDays).toBe(30);
    expect(body.data.unit).toBe("ml");
    expect(body.data.days).toHaveLength(30);
    expect(body.data.days.every((d) => d.amount === 0)).toBe(true);
    // Ascending, contiguous day keys, ending on "today".
    for (let i = 1; i < body.data.days.length; i++) {
      const prev = new Date(`${body.data.days[i - 1].day}T00:00:00.000Z`);
      const curr = new Date(`${body.data.days[i].day}T00:00:00.000Z`);
      expect(curr.getTime() - prev.getTime()).toBe(24 * 60 * 60 * 1000);
    }
  });

  it("folds sources within the same day before bucketing", async () => {
    // Relative day-keys — a fixed literal slides out of the window as the
    // calendar advances (a `?days=3` window only ever holds today..today-2).
    const utcDay = (offset: number) =>
      new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
    const today = utcDay(0);
    const yesterday = utcDay(1);
    vi.mocked(prisma.nutrientIntakeDay.findMany).mockResolvedValue([
      { day: today, amount: 900, source: "APPLE_HEALTH" },
      { day: today, amount: 600, source: "MANUAL" },
      // The smaller of two day-total sources does not count.
      { day: yesterday, amount: 400, source: "APPLE_HEALTH" },
      { day: yesterday, amount: 350, source: "EXTERNAL" },
    ] as never);

    const res = await GET(getReq("?nutrient=water&days=3"));
    const body = (await res.json()) as DailyResponse;
    const byDay = new Map(body.data.days.map((d) => [d.day, d.amount]));
    expect(byDay.get(today)).toBe(1500);
    expect(byDay.get(yesterday)).toBe(400);
  });

  it("resolves the sex-split reference against the caller's profile sex", async () => {
    vi.mocked(getSession).mockResolvedValue(sessionFor("FEMALE") as never);
    const res = await GET(getReq("?nutrient=water&days=7"));
    const body = (await res.json()) as DailyResponse;
    expect(body.data.reference).toEqual({
      authority: "EFSA",
      kind: "AI",
      direction: "target",
      value: 2000,
      source: expect.stringContaining("EFSA"),
    });
  });

  it("returns the person's own target for the code, and null without one", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      nutrientTargetsJson: {
        protein: { value: 120, direction: "target" },
        sugar: { value: 40, direction: "limit" },
      },
    } as never);
    const protein = (await (
      await GET(getReq("?nutrient=protein&days=7"))
    ).json()) as DailyResponse;
    expect(protein.data.personalTarget).toEqual({
      value: 120,
      direction: "target",
    });
    expect(protein.data.unit).toBe("g");
    const water = (await (
      await GET(getReq("?nutrient=water&days=7"))
    ).json()) as DailyResponse;
    expect(water.data.personalTarget).toBeNull();
  });

  it("omits the reference when the profile has no sex on file — never guesses", async () => {
    vi.mocked(getSession).mockResolvedValue(sessionFor(null) as never);
    const res = await GET(getReq("?nutrient=water&days=7"));
    const body = (await res.json()) as DailyResponse;
    expect(body.data.reference).toBeNull();
  });

  it("scopes the query to the authenticated user and the requested nutrient", async () => {
    await GET(getReq("?nutrient=caffeine&days=14"));
    expect(prisma.nutrientIntakeDay.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          nutrient: "caffeine",
          day: { gte: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
        }),
      }),
    );
  });
});

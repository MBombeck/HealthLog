/**
 * `POST /api/nutrients/batch` under a narrow `measurements:write` token.
 *
 * The credential picks the source row: a bridge token writes EXTERNAL in the
 * probe, the insert and the update, counts in its own rate-limit bucket, and
 * says so in the audit row; the native client keeps writing APPLE_HEALTH.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    nutrientIntakeDay: {
      findMany: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/api-handler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-handler")>();
  return { ...actual, requireAuth: vi.fn() };
});
vi.mock("@/lib/modules/gate", () => ({ requireModuleEnabled: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: () => ({}),
}));
vi.mock("@/lib/idempotency", () => ({
  withIdempotency:
    <Args extends unknown[]>(fn: (...args: Args) => Promise<Response>) =>
    (...args: Args) =>
      fn(...args),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserHealthContext: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { MEASUREMENTS_WRITE_SCOPE } from "@/lib/measurements/scopes";

const USER = { id: "user-1", username: "tester", role: "USER" as const };

function asBridge() {
  vi.mocked(requireAuth).mockResolvedValue({
    session: { id: "t" },
    user: USER,
    bearerScope: MEASUREMENTS_WRITE_SCOPE,
  } as never);
}

function asPhone() {
  vi.mocked(requireAuth).mockResolvedValue({
    session: { id: "s" },
    user: USER,
  } as never);
}

function post(entries: unknown[]): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/api/nutrients/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries }),
    }),
  );
}

const ENERGY = {
  day: "2026-11-01",
  nutrient: "energy",
  unit: "kcal",
  amount: 2100,
};
const PROTEIN = {
  day: "2026-11-02",
  nutrient: "protein",
  unit: "g",
  amount: 95,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true });
  vi.mocked(auditLog).mockResolvedValue(undefined as never);
  // ENERGY's day already exists, PROTEIN's is new.
  vi.mocked(prisma.nutrientIntakeDay.findMany).mockResolvedValue([
    { day: ENERGY.day, nutrient: "energy" },
  ] as never);
  vi.mocked(prisma.nutrientIntakeDay.createMany).mockImplementation(
    (async (args: { data: unknown[] }) => ({
      count: args.data.length,
    })) as never,
  );
  vi.mocked(prisma.nutrientIntakeDay.update).mockResolvedValue({} as never);
  vi.mocked(prisma.$transaction).mockImplementation((async (ops: unknown[]) =>
    Promise.all(ops)) as never);
});

describe("POST /api/nutrients/batch with a measurements:write token", () => {
  it("asks requireAuth for the measurements:write scope", async () => {
    asBridge();
    await post([ENERGY]);
    expect(requireAuth).toHaveBeenCalledWith(MEASUREMENTS_WRITE_SCOPE, {
      writeBucket: "own",
    });
  });

  it("writes the EXTERNAL row in the probe, the insert and the update", async () => {
    asBridge();
    const res = await post([ENERGY, PROTEIN]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { inserted: number; updated: number };
    };
    expect(body.data).toMatchObject({ inserted: 1, updated: 1 });

    const probe = vi.mocked(prisma.nutrientIntakeDay.findMany).mock.calls[0][0];
    expect(probe?.where).toMatchObject({
      userId: "user-1",
      source: "EXTERNAL",
    });
    const created = vi.mocked(prisma.nutrientIntakeDay.createMany).mock
      .calls[0][0] as { data: Array<{ source: string; nutrient: string }> };
    expect(created.data).toEqual([
      expect.objectContaining({ nutrient: "protein", source: "EXTERNAL" }),
    ]);
    const update = vi.mocked(prisma.nutrientIntakeDay.update).mock.calls[0][0];
    expect(update.where).toEqual({
      userId_day_nutrient_source: {
        userId: "user-1",
        day: ENERGY.day,
        nutrient: "energy",
        source: "EXTERNAL",
      },
    });
  });

  it("counts in the bridge bucket and names the source in the audit row", async () => {
    asBridge();
    await post([ENERGY]);
    expect(vi.mocked(checkRateLimit).mock.calls[0][0]).toBe(
      "nutrients:batch:bridge:user-1",
    );
    expect(auditLog).toHaveBeenCalledWith(
      "nutrient.batch.ingest",
      expect.objectContaining({
        details: expect.objectContaining({ source: "EXTERNAL" }),
      }),
    );
  });

  it("accepts alcohol, which no HealthKit type carries", async () => {
    asBridge();
    const res = await post([
      { day: "2026-11-01", nutrient: "alcohol", unit: "g", amount: 24 },
    ]);
    const body = (await res.json()) as { data: { skipped: unknown[] } };
    expect(body.data.skipped).toEqual([]);
  });

  it("skips energy posted in kJ rather than converting it", async () => {
    asBridge();
    const res = await post([{ ...ENERGY, unit: "kJ", amount: 8800 }]);
    const body = (await res.json()) as {
      data: { skipped: Array<{ reason: string }> };
    };
    expect(body.data.skipped).toEqual([{ index: 0, reason: "unit_mismatch" }]);
  });
});

describe("POST /api/nutrients/batch from the native client", () => {
  it("keeps writing the APPLE_HEALTH row in its own bucket", async () => {
    asPhone();
    await post([ENERGY, PROTEIN]);
    expect(vi.mocked(checkRateLimit).mock.calls[0][0]).toBe(
      "nutrients:batch:user-1",
    );
    const probe = vi.mocked(prisma.nutrientIntakeDay.findMany).mock.calls[0][0];
    expect(probe?.where).toMatchObject({ source: "APPLE_HEALTH" });
    const created = vi.mocked(prisma.nutrientIntakeDay.createMany).mock
      .calls[0][0] as { data: Array<{ source: string }> };
    expect(created.data.every((r) => r.source === "APPLE_HEALTH")).toBe(true);
    expect(auditLog).toHaveBeenCalledWith(
      "nutrient.batch.ingest",
      expect.objectContaining({
        details: expect.objectContaining({ source: "APPLE_HEALTH" }),
      }),
    );
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/tz/resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tz/resolver")>();
  return { ...actual, resolveUserTimezone: vi.fn(async () => "UTC") };
});

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/rollups/measurement-read", () => ({
  loadUserSourcePriority: vi.fn(async () => null),
}));

// v1.18.0 — pin the sleep module gate to "enabled" so this suite stays
// focused on the sleep-rhythm read; the gate is covered elsewhere.
vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(async () => ({ enabled: true })),
}));

vi.mock("@/lib/logging/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging/context")>();
  return { ...actual, annotate: vi.fn() };
});

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
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

// `apiHandler` always reads `request.url`; the inner handler ignores it, so we
// bypass the arity check with a cast (same pattern as the dashboard summary
// test).
const callGet = GET as unknown as (req: NextRequest) => Promise<Response>;
function req(): NextRequest {
  return new NextRequest("http://localhost/api/sleep/rhythm");
}

/** A bare-ASLEEP night: end = wake instant, asleep = `minutes`. */
function night(wakeIso: string, minutes: number) {
  return {
    value: minutes,
    measuredAt: new Date(wakeIso),
    sleepStage: "ASLEEP",
    source: "APPLE_HEALTH",
    deviceType: null,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    dateOfBirth: new Date("1986-01-01"),
    gender: null,
    heightCm: null,
  } as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
});

describe("GET /api/sleep/rhythm", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await callGet(req());
    expect(res.status).toBe(401);
  });

  it("returns the sleep-debt + chronotype DTO shape", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    // Sleep-debt DTO fields.
    expect(body.data.sleepDebt).toMatchObject({
      state: "partial",
      debtMinutes: 0,
      needMinutes: expect.any(Number),
      nightsCounted: 0,
      windowNights: expect.any(Number),
      nightsUntilReady: expect.any(Number),
    });
    // Chronotype DTO fields.
    expect(body.data.chronotype).toMatchObject({
      state: "learning",
      msfMinutes: null,
      msfScMinutes: null,
      band: null,
      socialJetlagMinutes: null,
      freeNightsCounted: 0,
      workNightsCounted: 0,
      freeNightsUntilReady: expect.any(Number),
    });
  });

  it("reaches the ready debt state with a full window of short nights", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // Ten consecutive nights of 6 h (360 min); need is 420 → 60/night deficit.
    const rows = [];
    for (let d = 1; d <= 10; d++) {
      const day = String(d).padStart(2, "0");
      rows.push(night(`2026-06-${day}T06:00:00.000Z`, 360));
    }
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(rows as never);

    const res = await callGet(req());
    const body = await res.json();
    expect(body.data.sleepDebt.state).toBe("ready");
    // v1.19.0 — the rolling balance counts the most recent 5-night window.
    expect(body.data.sleepDebt.nightsCounted).toBe(5);
    expect(body.data.sleepDebt.nightsUntilReady).toBe(0);
    // 5-night window × 60-min nightly deficit (all short, no catch-up) = 300 min
    // running balance.
    expect(body.data.sleepDebt.debtMinutes).toBe(300);
    expect(body.data.sleepDebt.needMinutes).toBe(420);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    measurement: { findMany: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    // v1.4.31 — gated on `assistant.insightStatus`; null row falls
    // back to the all-on default so existing assertions ride
    // through unchanged.
    appSettings: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

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
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    heightCm: null,
    dateOfBirth: null,
    aiProvider: null,
  } as never);
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);
});

const callGet = GET as unknown as (req: NextRequest) => Promise<Response>;
function makeReq(): NextRequest {
  return new NextRequest("http://localhost/api/insights/cards");
}

describe("GET /api/insights/cards — assistant-flag gate", () => {
  it("returns 403 + errorCode when insightStatus is disabled", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValueOnce({
      assistantEnabled: true,
      assistantCoachEnabled: true,
      assistantBriefingEnabled: true,
      assistantInsightStatusEnabled: false,
      assistantCorrelationsEnabled: true,
      assistantHealthScoreExplainerEnabled: true,
    } as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("assistant.disabled.insightStatus");
  });

  it("returns 403 when the master flag is off", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValueOnce({
      assistantEnabled: false,
      assistantCoachEnabled: true,
      assistantBriefingEnabled: true,
      assistantInsightStatusEnabled: true,
      assistantCorrelationsEnabled: true,
      assistantHealthScoreExplainerEnabled: true,
    } as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(403);
  });
});

describe("GET /api/insights/cards", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await callGet(makeReq());
    expect(res.status).toBe(401);
  });

  it("returns an empty array when no data is available", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(0);
  });

  it("emits cards when measurements trigger alerts", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // Provide enough sys + dia measurements to trigger danger-level alert.
    const now = new Date();
    const measurements: Array<{
      type: string;
      value: number;
      measuredAt: Date;
    }> = [];
    for (let i = 0; i < 10; i++) {
      const at = new Date(now.getTime() - i * 86_400_000);
      measurements.push({
        type: "BLOOD_PRESSURE_SYS",
        value: 180,
        measuredAt: at,
      });
      measurements.push({
        type: "BLOOD_PRESSURE_DIA",
        value: 110,
        measuredAt: at,
      });
    }
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(
      measurements as never,
    );
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      heightCm: null,
      dateOfBirth: null,
      aiProvider: "ANTHROPIC",
    } as never);

    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ severity: string; provider: string; title: string }>;
    };
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].provider).toBe("anthropic");
    expect(body.data.some((c) => c.severity === "alert")).toBe(true);
  });
});

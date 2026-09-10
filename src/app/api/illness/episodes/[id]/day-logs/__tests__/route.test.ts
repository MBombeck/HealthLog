/**
 * v1.18.3 — GET /api/illness/episodes/{id}/day-logs.
 *
 * Covers the date-less LIST mode (paged, newest-first, `meta.total`), the
 * cursor/offset paging params, and that the legacy single-`date` read still
 * resolves one row (back-compat). The episode is owned + live and the module
 * gate is enabled in every case below.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    illnessEpisode: { findUnique: vi.fn() },
    illnessDayLog: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/illness/gate", () => ({
  requireIllnessEnabled: vi.fn(),
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
import { requireIllnessEnabled } from "@/lib/illness/gate";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

const PARAMS = { params: Promise.resolve({ id: "ep-1" }) };

function makeRow(date: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `dl-${date}`,
    episodeId: "ep-1",
    date,
    functionalImpact: 1,
    feverC: null,
    noteEncrypted: null,
    updatedAt: new Date("2026-06-15T00:00:00.000Z"),
    symptomLinks: [],
    ...overrides,
  };
}

function getReq(qs: string): NextRequest {
  const suffix = qs ? `?${qs}` : "";
  return new NextRequest(
    `http://localhost/api/illness/episodes/ep-1/day-logs${suffix}`,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(requireIllnessEnabled).mockResolvedValue({ enabled: true });
  vi.mocked(prisma.illnessEpisode.findUnique).mockResolvedValue({
    userId: "user-1",
    deletedAt: null,
  } as never);
});

describe("GET /api/illness/episodes/{id}/day-logs — date-less list", () => {
  it("returns paged day-logs newest-first with meta.total", async () => {
    vi.mocked(prisma.illnessDayLog.findMany).mockResolvedValue([
      makeRow("2026-06-15"),
      makeRow("2026-06-14"),
    ] as never);
    vi.mocked(prisma.illnessDayLog.count).mockResolvedValue(5 as never);

    const res = await GET(getReq(""), PARAMS);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        dayLogs: Array<{ id: string; date: string }>;
        meta: { total: number; limit: number; offset: number };
      };
    };
    expect(body.data.dayLogs).toHaveLength(2);
    expect(body.data.dayLogs[0].date).toBe("2026-06-15");
    expect(body.data.meta).toEqual({ total: 5, limit: 60, offset: 0 });

    // Default sort is newest-first; the list query never carries a `date`.
    const findArgs = vi.mocked(prisma.illnessDayLog.findMany).mock.calls[0][0];
    expect(findArgs).toMatchObject({
      where: { episodeId: "ep-1", deletedAt: null },
      // `date` is a calendar day and repeats within an episode, so the
      // unique tiebreaker is what keeps `skip`-based paging from repeating
      // one row and dropping another between pages.
      orderBy: [{ date: "desc" }, { id: "desc" }],
      take: 60,
      skip: 0,
    });
    expect(vi.mocked(prisma.illnessDayLog.findFirst)).not.toHaveBeenCalled();
  });

  it("honours limit/offset/sortDir paging params", async () => {
    vi.mocked(prisma.illnessDayLog.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.illnessDayLog.count).mockResolvedValue(0 as never);

    const res = await GET(getReq("limit=10&offset=20&sortDir=asc"), PARAMS);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { meta: { total: number; limit: number; offset: number } };
    };
    expect(body.data.meta).toEqual({ total: 0, limit: 10, offset: 20 });

    const findArgs = vi.mocked(prisma.illnessDayLog.findMany).mock.calls[0][0];
    expect(findArgs).toMatchObject({
      orderBy: [{ date: "asc" }, { id: "asc" }],
      take: 10,
      skip: 20,
    });
  });

  it("422s on an out-of-range limit", async () => {
    const res = await GET(getReq("limit=9999"), PARAMS);
    expect(res.status).toBe(422);
    expect(vi.mocked(prisma.illnessDayLog.findMany)).not.toHaveBeenCalled();
  });
});

describe("GET /api/illness/episodes/{id}/day-logs — single-day (back-compat)", () => {
  it("returns one day-log for an explicit date", async () => {
    vi.mocked(prisma.illnessDayLog.findFirst).mockResolvedValue(
      makeRow("2026-06-10") as never,
    );

    const res = await GET(getReq("date=2026-06-10"), PARAMS);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { id: string; date: string } | null;
    };
    expect(body.data?.date).toBe("2026-06-10");

    const findArgs = vi.mocked(prisma.illnessDayLog.findFirst).mock.calls[0][0];
    expect(findArgs).toMatchObject({
      where: { episodeId: "ep-1", date: "2026-06-10", deletedAt: null },
    });
    expect(vi.mocked(prisma.illnessDayLog.findMany)).not.toHaveBeenCalled();
  });

  it("returns null when nothing is logged that day", async () => {
    vi.mocked(prisma.illnessDayLog.findFirst).mockResolvedValue(null as never);

    const res = await GET(getReq("date=2026-06-09"), PARAMS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown };
    expect(body.data).toBeNull();
  });

  it("422s on a malformed date", async () => {
    const res = await GET(getReq("date=06-2026"), PARAMS);
    expect(res.status).toBe(422);
    expect(vi.mocked(prisma.illnessDayLog.findFirst)).not.toHaveBeenCalled();
  });
});

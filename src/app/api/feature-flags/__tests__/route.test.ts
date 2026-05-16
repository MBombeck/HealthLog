import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

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

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: {
      findUnique: vi.fn(),
    },
  },
}));

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

function req(): NextRequest {
  return new NextRequest("http://localhost/api/feature-flags", {
    method: "GET",
  });
}

const FIND = prisma.appSettings.findUnique as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/feature-flags", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("returns the all-on default shape for a fresh install", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    FIND.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        assistant: {
          enabled: boolean;
          coach: boolean;
          briefing: boolean;
          insightStatus: boolean;
          correlations: boolean;
          healthScoreExplainer: boolean;
        };
      };
      error: null;
    };

    expect(body.error).toBeNull();
    expect(body.data.assistant).toEqual({
      enabled: true,
      coach: true,
      briefing: true,
      insightStatus: true,
      correlations: true,
      healthScoreExplainer: true,
    });
  });

  it("forces every sub-flag false when the master is off", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    FIND.mockResolvedValue({
      assistantEnabled: false,
      assistantCoachEnabled: true,
      assistantBriefingEnabled: true,
      assistantInsightStatusEnabled: true,
      assistantCorrelationsEnabled: true,
      assistantHealthScoreExplainerEnabled: true,
    });

    const res = await GET(req());
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { assistant: Record<string, boolean> };
    };

    expect(body.data.assistant).toEqual({
      enabled: false,
      coach: false,
      briefing: false,
      insightStatus: false,
      correlations: false,
      healthScoreExplainer: false,
    });
  });

  it("reads each sub-flag column", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    FIND.mockResolvedValue({
      assistantEnabled: true,
      assistantCoachEnabled: false,
      assistantBriefingEnabled: true,
      assistantInsightStatusEnabled: false,
      assistantCorrelationsEnabled: true,
      assistantHealthScoreExplainerEnabled: false,
    });

    const res = await GET(req());
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { assistant: Record<string, boolean> };
    };

    expect(body.data.assistant).toEqual({
      enabled: true,
      coach: false,
      briefing: true,
      insightStatus: false,
      correlations: true,
      healthScoreExplainer: false,
    });
  });

  it("attaches a private 60-second Cache-Control header", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    FIND.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=60");
  });
});

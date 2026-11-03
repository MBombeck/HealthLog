import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

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
  user: { id: "user-1", username: "testuser", role: "USER" as const },
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
          documentAi: boolean;
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
      documentAi: true,
    });
  });

  it("forces every sub-flag false when the master is off", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    FIND.mockResolvedValue({
      assistantEnabled: false,
      assistantCoachEnabled: true,
      assistantBriefingEnabled: true,
      assistantInsightStatusEnabled: true,
      assistantDocumentAiEnabled: true,
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
      documentAi: false,
    });
  });

  it("reads each sub-flag column", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    FIND.mockResolvedValue({
      assistantEnabled: true,
      assistantCoachEnabled: false,
      assistantBriefingEnabled: true,
      assistantInsightStatusEnabled: false,
      assistantDocumentAiEnabled: true,
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
      documentAi: true,
    });
  });

  it("attaches a private 60-second Cache-Control header", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    FIND.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=60");
  });

  it("announces itself deprecated and names its successor", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    FIND.mockResolvedValue(null);
    const res = await GET(req());
    // RFC 9745: the deprecation date as `@` and Unix seconds — 2026-09-24.
    expect(res.headers.get("Deprecation")).toBe("@1790208000");
    // RFC 8594: the first day it may stop answering.
    expect(res.headers.get("Sunset")).toBe("Wed, 31 Mar 2027 00:00:00 GMT");
    expect(res.headers.get("Link")).toBe(
      '</api/auth/me>; rel="successor-version"',
    );
  });

  it("answers every switch off when the switches cannot be read", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    FIND.mockRejectedValue(new Error("db down"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { assistant: Record<string, boolean> };
    };
    expect(Object.values(body.data.assistant).every((v) => v === false)).toBe(
      true,
    );
  });
});

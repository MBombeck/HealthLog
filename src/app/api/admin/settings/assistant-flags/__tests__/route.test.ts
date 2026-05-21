import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
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

import { GET, PUT } from "../route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

const ADMIN_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "admin-1", username: "marc", role: "ADMIN" as const },
};
const USER_OK = {
  session: { id: "sess-2", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "bob", role: "USER" as const },
};

const ALL_ON = {
  assistantEnabled: true,
  assistantCoachEnabled: true,
  assistantBriefingEnabled: true,
  assistantInsightStatusEnabled: true,
  assistantCorrelationsEnabled: true,
  assistantHealthScoreExplainerEnabled: true,
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/admin/settings/assistant-flags", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await (GET as unknown as (r: NextRequest) => Promise<Response>)(
      new NextRequest("http://localhost/api/admin/settings/assistant-flags"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller is not an admin", async () => {
    vi.mocked(getSession).mockResolvedValue(USER_OK as never);
    const res = await (GET as unknown as (r: NextRequest) => Promise<Response>)(
      new NextRequest("http://localhost/api/admin/settings/assistant-flags"),
    );
    expect(res.status).toBe(403);
  });

  it("returns the all-on raw + resolved shape for a fresh install", async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_OK as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null);
    const res = await (GET as unknown as (r: NextRequest) => Promise<Response>)(
      new NextRequest("http://localhost/api/admin/settings/assistant-flags"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        raw: Record<string, boolean>;
        resolved: Record<string, boolean>;
      };
    };
    expect(body.data.raw.assistantEnabled).toBe(true);
    expect(body.data.resolved.coach).toBe(true);
  });
});

describe("PUT /api/admin/settings/assistant-flags", () => {
  function putReq(payload: object) {
    return new NextRequest(
      "http://localhost/api/admin/settings/assistant-flags",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
  }

  it("returns 403 to a non-admin caller", async () => {
    vi.mocked(getSession).mockResolvedValue(USER_OK as never);
    const res = await PUT(putReq({ assistantCoachEnabled: false }));
    expect(res.status).toBe(403);
  });

  it("flips a sub-flag and echoes the resolved shape", async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_OK as never);
    vi.mocked(prisma.appSettings.upsert).mockResolvedValue({
      ...ALL_ON,
      assistantCoachEnabled: false,
    } as never);

    const res = await PUT(putReq({ assistantCoachEnabled: false }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { raw: Record<string, boolean>; resolved: Record<string, boolean> };
    };
    expect(body.data.raw.assistantCoachEnabled).toBe(false);
    expect(body.data.resolved.coach).toBe(false);
    expect(body.data.resolved.briefing).toBe(true);
  });

  it("forces every sub-flag false when the master is flipped off", async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_OK as never);
    vi.mocked(prisma.appSettings.upsert).mockResolvedValue({
      ...ALL_ON,
      assistantEnabled: false,
    } as never);

    const res = await PUT(putReq({ assistantEnabled: false }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { raw: Record<string, boolean>; resolved: Record<string, boolean> };
    };
    expect(body.data.resolved.enabled).toBe(false);
    expect(body.data.resolved.coach).toBe(false);
    expect(body.data.resolved.briefing).toBe(false);
    expect(body.data.resolved.insightStatus).toBe(false);
    expect(body.data.resolved.correlations).toBe(false);
    expect(body.data.resolved.healthScoreExplainer).toBe(false);
  });

  it("rejects an empty body", async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_OK as never);
    const res = await PUT(putReq({}));
    expect(res.status).toBe(422);
  });

  it("rejects unknown fields strictly", async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_OK as never);
    const res = await PUT(putReq({ assistantPotatoEnabled: false }));
    expect(res.status).toBe(422);
  });

  describe("v1.4.43 W6 — multi-issue 422 envelope", () => {
    it("surfaces TWO simultaneous validation errors", async () => {
      vi.mocked(getSession).mockResolvedValue(ADMIN_OK as never);
      // Two bad-typed flags.
      const res = await PUT(
        putReq({
          assistantEnabled: "string",
          assistantCoachEnabled: 999,
        }),
      );
      expect(res.status).toBe(422);
      const body = (await res.json()) as {
        data: null;
        error: string;
        details: {
          issues: Array<{ path: string; code: string; message: string }>;
        };
      };
      expect(body.data).toBeNull();
      expect(body.error).toBe("Validation failed");
      expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
      for (const issue of body.details.issues) {
        expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
      }
    });

    it("surfaces THREE simultaneous validation errors", async () => {
      vi.mocked(getSession).mockResolvedValue(ADMIN_OK as never);
      const res = await PUT(
        putReq({
          assistantEnabled: "string",
          assistantCoachEnabled: 999,
          assistantBriefingEnabled: "string",
        }),
      );
      expect(res.status).toBe(422);
      const body = (await res.json()) as {
        details: { issues: Array<unknown> };
      };
      expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
    });
  });
});

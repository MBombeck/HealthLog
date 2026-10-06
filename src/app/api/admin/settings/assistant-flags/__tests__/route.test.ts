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
  user: { id: "admin-1", username: "testuser", role: "ADMIN" as const },
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
  assistantDocumentAiEnabled: true,
  aiReasoningEnabled: true,
  aiReasoningMaxEffort: "high",
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

  it("publishes the reasoning controls, defaulted on and uncapped", async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_OK as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null);
    const res = await (GET as unknown as (r: NextRequest) => Promise<Response>)(
      new NextRequest("http://localhost/api/admin/settings/assistant-flags"),
    );
    const body = (await res.json()) as {
      data: { reasoning: { enabled: boolean; maxEffort: string } };
    };
    expect(body.data.reasoning).toEqual({ enabled: true, maxEffort: "high" });
  });

  it("reads a stored cap and an off switch back", async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_OK as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      ...ALL_ON,
      aiReasoningEnabled: false,
      aiReasoningMaxEffort: "low",
    } as never);
    const res = await (GET as unknown as (r: NextRequest) => Promise<Response>)(
      new NextRequest("http://localhost/api/admin/settings/assistant-flags"),
    );
    const body = (await res.json()) as {
      data: { reasoning: { enabled: boolean; maxEffort: string } };
    };
    expect(body.data.reasoning).toEqual({ enabled: false, maxEffort: "low" });
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
    expect(body.data.resolved.documentAi).toBe(false);
  });

  it("switches reasoning off and caps it, with an audit row", async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_OK as never);
    vi.mocked(prisma.appSettings.upsert).mockResolvedValue({
      ...ALL_ON,
      aiReasoningEnabled: false,
      aiReasoningMaxEffort: "medium",
    } as never);

    const res = await PUT(
      putReq({ aiReasoningEnabled: false, aiReasoningMaxEffort: "medium" }),
    );
    expect(res.status).toBe(200);
    const upsert = vi.mocked(prisma.appSettings.upsert).mock.calls[0][0];
    expect(upsert.update).toEqual({
      aiReasoningEnabled: false,
      aiReasoningMaxEffort: "medium",
    });
    const { auditLog } = await import("@/lib/auth/audit");
    expect(vi.mocked(auditLog).mock.calls[0][1]).toMatchObject({
      details: { aiReasoningEnabled: false, aiReasoningMaxEffort: "medium" },
    });
    const body = (await res.json()) as {
      data: { reasoning: { enabled: boolean; maxEffort: string } };
    };
    expect(body.data.reasoning).toEqual({
      enabled: false,
      maxEffort: "medium",
    });
  });

  it.each(["off", "xhigh", "", 3])(
    "refuses %s as the highest level",
    async (value) => {
      vi.mocked(getSession).mockResolvedValue(ADMIN_OK as never);
      const res = await PUT(putReq({ aiReasoningMaxEffort: value }));
      expect(res.status).toBe(422);
      expect(prisma.appSettings.upsert).not.toHaveBeenCalled();
    },
  );

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

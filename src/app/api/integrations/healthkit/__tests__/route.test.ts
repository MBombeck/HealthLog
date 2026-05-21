import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    // v1.4.43 W6 — audit-ledger breadcrumb for validation-failed paths.
    auditLog: { create: vi.fn() },
  },
  toJson: <T,>(v: T) => v,
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

import { GET, PATCH } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    healthKitConfigJson: null,
    healthKitLastSyncedAt: null,
  } as never);
  vi.mocked(prisma.user.update).mockResolvedValue({} as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
});

const callGet = GET as unknown as (req: NextRequest) => Promise<Response>;
function makeGetReq(): NextRequest {
  return new NextRequest("http://localhost/api/integrations/healthkit");
}

describe("GET /api/integrations/healthkit", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await callGet(makeGetReq());
    expect(res.status).toBe(401);
  });

  it("returns the default entries when nothing is stored", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callGet(makeGetReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { entries: Array<{ id: string; direction: string }> };
    };
    expect(body.data.entries.length).toBeGreaterThan(0);
    const bodyMass = body.data.entries.find((e) => e.id === "bodyMass");
    expect(bodyMass?.direction).toBe("bidirectional");
  });
});

describe("PATCH /api/integrations/healthkit", () => {
  function req(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/integrations/healthkit", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await PATCH(req({ entries: [] }));
    expect(res.status).toBe(401);
  });

  it("returns 422 for invalid direction", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await PATCH(
      req({ entries: [{ id: "bodyMass", direction: "FOO" }] }),
    );
    expect(res.status).toBe(422);
  });

  it("updates known entries and silently ignores unknown ids", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await PATCH(
      req({
        entries: [
          { id: "bodyMass", direction: "readOnly" },
          { id: "totallyUnknown", direction: "bidirectional" },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const updateArgs = vi.mocked(prisma.user.update).mock
      .calls[0][0] as unknown as {
      data: { healthKitConfigJson: { entries: Array<{ id: string }> } };
    };
    const ids = updateArgs.data.healthKitConfigJson.entries.map((e) => e.id);
    expect(ids).toContain("bodyMass");
    expect(ids).not.toContain("totallyUnknown");
  });
});

describe("PATCH /api/integrations/healthkit — 422 multi-issue (v1.4.43 W6)", () => {
  function patchReq(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/integrations/healthkit", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("surfaces TWO simultaneous validation errors", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // Two bad entries: first with bad direction, second with empty id.
    const res = await PATCH(
      patchReq({
        entries: [
          { id: "bodyMass", direction: "JUNK" },
          { id: "", direction: "readOnly" },
        ],
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
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await PATCH(
      patchReq({
        entries: [
          { id: "bodyMass", direction: "JUNK1" },
          { id: "", direction: "JUNK2" },
          { id: "weight", direction: "JUNK3" },
        ],
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("writes the audit-ledger row keyed integrations.healthkit.validation-failed", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await PATCH(
      patchReq({ entries: [{ id: "bodyMass", direction: "JUNK" }] }),
    );
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 5));
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0] as {
      data: { userId: string; action: string };
    };
    expect(call.data.action).toBe("integrations.healthkit.validation-failed");
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(
      new Error("db down"),
    );
    const res = await PATCH(
      patchReq({ entries: [{ id: "bodyMass", direction: "JUNK" }] }),
    );
    expect(res.status).toBe(422);
  });
});

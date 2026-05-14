import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
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
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

function mkPut(body: unknown): Request {
  return new Request("http://localhost/api/auth/me/source-priority", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/auth/me/source-priority", () => {
  it("rejects unauthenticated requests with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await (GET as () => Promise<Response>)();
    expect(res.status).toBe(401);
  });

  it("returns the resolved shape with defaults when the column is null", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      sourcePriorityJson: null,
    } as never);

    const res = await (GET as () => Promise<Response>)();
    expect(res.status).toBe(200);
    const env = (await res.json()) as { data: Record<string, unknown> };
    // Resolver always emits the keys the analytics layer needs.
    expect(env.data).toHaveProperty("weight");
    expect(env.data).toHaveProperty("metricPriority");
    expect(env.data).toHaveProperty("deviceTypePriority");
  });
});

describe("PUT /api/auth/me/source-priority", () => {
  it("rejects unauthenticated requests with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await (PUT as (r: Request) => Promise<Response>)(
      mkPut({ weight: ["WITHINGS", "APPLE_HEALTH", "MANUAL"] }),
    );
    expect(res.status).toBe(401);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("persists the partial shape", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      sourcePriorityJson: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const body = { weight: ["WITHINGS", "APPLE_HEALTH", "MANUAL"] };
    const res = await (PUT as (r: Request) => Promise<Response>)(mkPut(body));
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { sourcePriorityJson: body },
    });
  });

  it("rejects an invalid shape with 422", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await (PUT as (r: Request) => Promise<Response>)(
      mkPut({ weight: "not-an-array" }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  // ── v1.4.25 W10 reconcile (security M-3) ──
  it("writes an audit-log entry with the previous and new shape", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const previousShape = {
      weight: ["WITHINGS", "APPLE_HEALTH", "MANUAL"],
    };
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      sourcePriorityJson: previousShape,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const body = { weight: ["APPLE_HEALTH", "WITHINGS", "MANUAL"] };
    const res = await (PUT as (r: Request) => Promise<Response>)(mkPut(body));
    expect(res.status).toBe(200);
    expect(auditLog).toHaveBeenCalledWith(
      "user.source-priority.update",
      expect.objectContaining({
        userId: "user-1",
        details: expect.objectContaining({
          previous: previousShape,
          next: body,
        }),
      }),
    );
  });
});

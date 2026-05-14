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

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 4,
    resetAt: Date.now() + 60_000,
  }),
  rateLimitHeaders: () => ({}),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { DELETE, GET, POST } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { RESEARCH_MODE_DISCLAIMER_VERSION } from "@/lib/medications/glp1-pk";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

function mkPost(body: unknown): Request {
  return new Request("http://localhost/api/auth/me/research-mode", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function mkDelete(): Request {
  return new Request("http://localhost/api/auth/me/research-mode", {
    method: "DELETE",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/auth/me/research-mode", () => {
  it("rejects an unauthenticated request with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/research-mode"),
    );
    expect(res.status).toBe(401);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns the disabled default for a fresh user", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      researchModeEnabled: false,
      researchModeAcknowledgedAt: null,
      researchModeAcknowledgedVersion: null,
    } as never);

    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/research-mode"),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as {
      data: {
        enabled: boolean;
        acknowledgedAt: string | null;
        acknowledgedVersion: string | null;
        currentDisclaimerVersion: string;
      };
    };
    expect(env.data.enabled).toBe(false);
    expect(env.data.acknowledgedAt).toBeNull();
    expect(env.data.acknowledgedVersion).toBeNull();
    expect(env.data.currentDisclaimerVersion).toBe(
      RESEARCH_MODE_DISCLAIMER_VERSION,
    );
  });

  it("returns the enabled state with the persisted version", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const ackAt = new Date("2026-05-14T10:00:00Z");
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      researchModeEnabled: true,
      researchModeAcknowledgedAt: ackAt,
      researchModeAcknowledgedVersion: RESEARCH_MODE_DISCLAIMER_VERSION,
    } as never);

    const res = await (GET as (r: Request) => Promise<Response>)(
      new Request("http://localhost/api/auth/me/research-mode"),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as {
      data: {
        enabled: boolean;
        acknowledgedAt: string;
        acknowledgedVersion: string;
        currentDisclaimerVersion: string;
      };
    };
    expect(env.data.enabled).toBe(true);
    expect(env.data.acknowledgedAt).toBe(ackAt.toISOString());
    expect(env.data.acknowledgedVersion).toBe(
      RESEARCH_MODE_DISCLAIMER_VERSION,
    );
  });
});

describe("POST /api/auth/me/research-mode", () => {
  it("rejects an unauthenticated request with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await (POST as (r: Request) => Promise<Response>)(
      mkPost({ acknowledged: true, version: RESEARCH_MODE_DISCLAIMER_VERSION }),
    );
    expect(res.status).toBe(401);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("enables Research Mode and writes the audit log on a valid ack", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      researchModeEnabled: false,
      researchModeAcknowledgedAt: null,
      researchModeAcknowledgedVersion: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await (POST as (r: Request) => Promise<Response>)(
      mkPost({ acknowledged: true, version: RESEARCH_MODE_DISCLAIMER_VERSION }),
    );
    expect(res.status).toBe(200);
    const env = (await res.json()) as {
      data: { enabled: boolean; acknowledgedVersion: string };
    };
    expect(env.data.enabled).toBe(true);
    expect(env.data.acknowledgedVersion).toBe(
      RESEARCH_MODE_DISCLAIMER_VERSION,
    );

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-1" },
        data: expect.objectContaining({
          researchModeEnabled: true,
          researchModeAcknowledgedVersion: RESEARCH_MODE_DISCLAIMER_VERSION,
        }),
      }),
    );

    expect(auditLog).toHaveBeenCalledWith(
      "user.research-mode.enable",
      expect.objectContaining({
        userId: "user-1",
        details: expect.objectContaining({
          next: expect.objectContaining({
            researchModeEnabled: true,
            researchModeAcknowledgedVersion: RESEARCH_MODE_DISCLAIMER_VERSION,
          }),
        }),
      }),
    );
  });

  it("rejects a stale disclaimer version with 400", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    const res = await (POST as (r: Request) => Promise<Response>)(
      mkPost({ acknowledged: true, version: "1970-01-01.0" }),
    );
    expect(res.status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("rejects a body without acknowledged=true with 422", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    const res = await (POST as (r: Request) => Promise<Response>)(
      mkPost({ version: RESEARCH_MODE_DISCLAIMER_VERSION }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("returns 429 when the per-user rate-limit fires", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 30_000,
    });

    const res = await (POST as (r: Request) => Promise<Response>)(
      mkPost({ acknowledged: true, version: RESEARCH_MODE_DISCLAIMER_VERSION }),
    );
    expect(res.status).toBe(429);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/auth/me/research-mode", () => {
  it("rejects an unauthenticated request with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await (DELETE as (r: Request) => Promise<Response>)(mkDelete());
    expect(res.status).toBe(401);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("disables Research Mode and clears the acknowledgment", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      researchModeEnabled: true,
      researchModeAcknowledgedAt: new Date(),
      researchModeAcknowledgedVersion: RESEARCH_MODE_DISCLAIMER_VERSION,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await (DELETE as (r: Request) => Promise<Response>)(mkDelete());
    expect(res.status).toBe(200);
    const env = (await res.json()) as {
      data: {
        enabled: boolean;
        acknowledgedAt: string | null;
        acknowledgedVersion: string | null;
      };
    };
    expect(env.data.enabled).toBe(false);
    expect(env.data.acknowledgedAt).toBeNull();
    expect(env.data.acknowledgedVersion).toBeNull();

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        researchModeEnabled: false,
        researchModeAcknowledgedAt: null,
        researchModeAcknowledgedVersion: null,
      },
    });

    expect(auditLog).toHaveBeenCalledWith(
      "user.research-mode.disable",
      expect.objectContaining({
        userId: "user-1",
        details: expect.objectContaining({
          next: {
            researchModeEnabled: false,
            researchModeAcknowledgedAt: null,
            researchModeAcknowledgedVersion: null,
          },
        }),
      }),
    );
  });

  it("is idempotent when Research Mode is already off", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      researchModeEnabled: false,
      researchModeAcknowledgedAt: null,
      researchModeAcknowledgedVersion: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await (DELETE as (r: Request) => Promise<Response>)(mkDelete());
    expect(res.status).toBe(200);
    // The route writes the canonical off-state even when the
    // column is already off — guarantees audit trail symmetry.
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledTimes(1);
  });
});

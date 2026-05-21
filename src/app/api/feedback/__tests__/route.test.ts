import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({
    user: { id: "u-1", email: "test@example.com", role: "USER" },
    session: { id: "s-1" },
  })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: vi.fn() },
    feedback: { create: vi.fn() },
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn(async () => undefined),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";

beforeEach(() => {
  vi.resetAllMocks();
});

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/feedback bug-report toggle gate", () => {
  it("returns 503 when bugReportEnabled is false", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      bugReportEnabled: false,
    } as never);

    const res = await POST(
      jsonRequest({
        category: "BUG",
        subject: "test",
        description: "Anything at least ten characters long.",
      }) as never,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/disabled/i);
    expect(prisma.feedback.create).not.toHaveBeenCalled();
  });

  it("creates feedback when bugReportEnabled is true", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      bugReportEnabled: true,
    } as never);
    vi.mocked(prisma.feedback.create).mockResolvedValue({
      id: "fb-1",
      createdAt: new Date(),
      category: "BUG",
      status: "NEW",
    } as never);

    const res = await POST(
      jsonRequest({
        category: "BUG",
        subject: "test",
        description: "Anything at least ten characters long.",
      }) as never,
    );
    expect(res.status).toBe(201);
    expect(prisma.feedback.create).toHaveBeenCalledTimes(1);
  });

  it("creates feedback when bugReportEnabled has never been written (default ON)", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.feedback.create).mockResolvedValue({
      id: "fb-2",
      createdAt: new Date(),
      category: "BUG",
      status: "NEW",
    } as never);

    const res = await POST(
      jsonRequest({
        category: "BUG",
        subject: "test",
        description: "Anything at least ten characters long.",
      }) as never,
    );
    expect(res.status).toBe(201);
    expect(prisma.feedback.create).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/feedback — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      bugReportEnabled: true,
    } as never);
    // subject too short + description too short.
    const res = await POST(
      jsonRequest({
        category: "BUG",
        subject: "x",
        description: "short",
      }) as never,
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
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      bugReportEnabled: true,
    } as never);
    // bad subject + bad description + bad screenshot.
    const res = await POST(
      jsonRequest({
        category: "BUG",
        subject: "x",
        description: "short",
        screenshot: "not-a-data-url",
      }) as never,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });
});

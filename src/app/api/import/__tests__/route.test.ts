import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u-1" }, session: { id: "s-1" } })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { create: vi.fn() },
    moodEntry: { create: vi.fn() },
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

import { NextRequest } from "next/server";
import { POST } from "../route";
import { checkRateLimit } from "@/lib/rate-limit";

beforeEach(() => {
  vi.resetAllMocks();
});

interface ApiErrorEnvelope {
  data: null;
  error: string;
}

// V3 audit: /api/import POST had no rate-limit. Bulk-injection vector
// (max:10000 records per call). Now capped at 5/hour/user.
describe("POST /api/import — rate-limit guard", () => {
  it("returns 429 when the user has exhausted the 5/hour quota (HIGH coverage gap)", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 1000),
    } as never);

    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({ measurements: [] }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBe(429);
    const body = (await response.json()) as ApiErrorEnvelope;
    expect(body.error).toMatch(/per hour/i);
    expect(checkRateLimit).toHaveBeenCalledWith(
      expect.stringContaining("import:u-1"),
      5,
      60 * 60 * 1000,
    );
  });

  it("processes the request when within the quota", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 4,
      resetAt: new Date(Date.now() + 1000),
    } as never);

    const response = await POST(
      new NextRequest("http://localhost/api/import", {
        method: "POST",
        body: JSON.stringify({ measurements: [] }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBeLessThan(400);
  });
});

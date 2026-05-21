/**
 * v1.4.43 W14 — POST /api/integrations/withings/resume
 *
 * Three pins:
 *   1. Happy path: a parked row resumes, response carries
 *      `wasParked: true`.
 *   2. Idempotent: a connected row resumes silently, response carries
 *      `wasParked: false`.
 *   3. Rate-limit: a 6th call within the window returns 429 with the
 *      `rate_limited_self` error code.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({
    user: { id: "u-1" },
    session: { id: "s-1" },
  })),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({
    allowed: true,
    remaining: 5,
    resetAt: Date.now() + 60_000,
  })),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

vi.mock("@/lib/integrations/status", () => ({
  resumeIntegrationFromPark: vi.fn(),
}));

import { POST } from "../route";
import { checkRateLimit } from "@/lib/rate-limit";
import { resumeIntegrationFromPark } from "@/lib/integrations/status";

interface ApiEnvelope<T> {
  data: T | null;
  error: string | null;
}

function emptyRequest(): Request {
  return new Request("http://localhost/api/integrations/withings/resume", {
    method: "POST",
    headers: { "content-length": "0" },
  });
}

beforeEach(() => {
  vi.mocked(resumeIntegrationFromPark).mockReset();
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 5,
    resetAt: Date.now() + 60_000,
  } as never);
});

describe("POST /api/integrations/withings/resume", () => {
  it("clears a parked integration and reports wasParked: true", async () => {
    vi.mocked(resumeIntegrationFromPark).mockResolvedValueOnce({
      wasParked: true,
    });

    const response = await POST();
    expect(response.status).toBe(200);
    const body = (await response.json()) as ApiEnvelope<{
      resumed: boolean;
      wasParked: boolean;
    }>;
    expect(body.data).toEqual({ resumed: true, wasParked: true });
    expect(resumeIntegrationFromPark).toHaveBeenCalledWith("u-1", "withings");
  });

  it("returns wasParked: false when the row was already connected", async () => {
    vi.mocked(resumeIntegrationFromPark).mockResolvedValueOnce({
      wasParked: false,
    });

    const response = await POST();
    expect(response.status).toBe(200);
    const body = (await response.json()) as ApiEnvelope<{
      resumed: boolean;
      wasParked: boolean;
    }>;
    expect(body.data).toEqual({ resumed: true, wasParked: false });
  });

  it("returns 429 with rate_limited_self when the rate limit is exhausted", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    } as never);

    const response = await POST();
    expect(response.status).toBe(429);
    const body = (await response.json()) as ApiEnvelope<unknown> & {
      meta?: { errorCode?: string };
    };
    expect(body.error).toBeTruthy();
    expect(body.meta?.errorCode).toBe("rate_limited_self");
    expect(resumeIntegrationFromPark).not.toHaveBeenCalled();
  });
});

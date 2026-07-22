import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type * as ApiHandlerModule from "@/lib/api-handler";

vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof ApiHandlerModule>("@/lib/api-handler");
  return {
    ...actual,
    requireAuth: vi.fn(async () => ({ user: { id: "u1" } })),
  };
});

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("@/lib/google-health/sync", () => ({
  syncUserGoogleHealth: vi.fn(),
}));

import { POST } from "../route";
import { checkRateLimit } from "@/lib/rate-limit";
import { syncUserGoogleHealth } from "@/lib/google-health/sync";

function request(body: unknown = {}): NextRequest {
  return new NextRequest("http://localhost/api/google-health/sync", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
});

describe("POST /api/google-health/sync", () => {
  it("returns a non-success envelope when the core sync reports failure", async () => {
    vi.mocked(syncUserGoogleHealth).mockResolvedValue({
      imported: 0,
      failed: true,
    });

    const response = await POST(request());
    const envelope = (await response.json()) as {
      data: unknown;
      error: string | null;
    };

    expect(response.status).toBe(502);
    expect(envelope.data).toBeNull();
    expect(envelope.error).toBe("Google Health sync failed");
  });

  it("keeps the successful imported-count response unchanged", async () => {
    vi.mocked(syncUserGoogleHealth).mockResolvedValue({
      imported: 7,
      failed: false,
    });

    const response = await POST(request());
    const envelope = (await response.json()) as {
      data: { imported: number; fullSync: boolean };
      error: string | null;
    };

    expect(response.status).toBe(200);
    expect(envelope).toEqual({
      data: { imported: 7, fullSync: false },
      error: null,
    });
    expect(syncUserGoogleHealth).toHaveBeenCalledWith("u1", {
      fullSync: false,
    });
  });
});

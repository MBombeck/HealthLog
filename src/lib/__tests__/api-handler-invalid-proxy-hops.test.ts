import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/hmac", () => ({ hashToken: vi.fn() }));
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

import { NextRequest } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { getClientIp } from "@/lib/api-response";

/**
 * A typo in `TRUST_PROXY_HOPS` used to make every request that asked for the
 * client address throw, and `apiHandler` asks for it on every request to
 * record it: every route answered 500, the health probe included, so the
 * container looked dead for a configuration slip. It now resolves no address
 * and the boot log names the value.
 */
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("apiHandler with an invalid TRUST_PROXY_HOPS", () => {
  it("answers the route instead of 500, with no client address", async () => {
    vi.stubEnv("TRUST_PROXY_HOPS", "two");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: Array<string | null> = [];
    const route = apiHandler(async (request: NextRequest) => {
      seen.push(getClientIp(request));
      return Response.json({ data: { status: "ok" }, error: null });
    });
    const response = await route(
      new NextRequest("https://health.example.com/api/health", {
        headers: { "x-forwarded-for": "203.0.113.4" },
      }),
    );
    expect(response.status).toBe(200);
    expect(seen).toEqual([null]);
  });
});

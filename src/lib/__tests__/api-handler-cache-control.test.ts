import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/hmac", () => ({ hashToken: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/monitoring/glitchtip", () => ({
  sendGlitchtipEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { NextRequest } from "next/server";
import { apiHandler, HttpError } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceApiNoStore } from "@/lib/http/api-cache-policy";

function call(handler: () => Promise<Response>) {
  const route = apiHandler(async (_request: NextRequest) => handler());
  return route(new NextRequest("http://localhost/api/probe"));
}

function expectNoStore(res: Response) {
  expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  expect(res.headers.get("Pragma")).toBe("no-cache");
}

describe("apiHandler: no API answer is kept in a cache", () => {
  it("marks a success that set no Cache-Control of its own", async () => {
    expectNoStore(await call(async () => apiSuccess({ value: 1 })));
  });

  it("marks an error envelope, a thrown HttpError and an unexpected throw", async () => {
    expectNoStore(await call(async () => apiError("Nope", 409)));
    expectNoStore(
      await call(async () => {
        throw new HttpError(401, "Not authenticated");
      }),
    );
    expectNoStore(
      await call(async () => {
        throw new Error("boom");
      }),
    );
  });

  it("marks a hand-built response without a body", async () => {
    expectNoStore(await call(async () => new Response(null, { status: 204 })));
  });

  it("keeps a posture the route chose itself", async () => {
    const res = await call(async () => {
      const r = apiSuccess([]);
      r.headers.set("Cache-Control", "private, no-cache");
      return r;
    });
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(res.headers.get("Pragma")).toBeNull();
  });
});

describe("enforceApiNoStore, for a response a library built", () => {
  it("replaces a stream's no-cache and keeps its no-transform", () => {
    const headers = new Headers({ "Cache-Control": "no-cache, no-transform" });
    enforceApiNoStore(headers);
    expect(headers.get("Cache-Control")).toBe(
      "private, no-store, no-transform",
    );
    expect(headers.get("Pragma")).toBe("no-cache");
  });

  it("sets the default where nothing was chosen and leaves no-store alone", () => {
    const bare = new Headers();
    enforceApiNoStore(bare);
    expect(bare.get("Cache-Control")).toBe("private, no-store");
    const strict = new Headers({ "Cache-Control": "no-store" });
    enforceApiNoStore(strict);
    expect(strict.get("Cache-Control")).toBe("no-store");
  });
});

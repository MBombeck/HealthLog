/**
 * The Fitbit routes after the integration's removal, as the shipped iPhone
 * app meets them.
 *
 * The app's Integrations screen reads `GET /api/fitbit/status` every time it
 * opens, and a 404 there painted the Fitbit card as an error. The status keeps
 * answering 200 in its old shape, "not connected", with `retired` beside it.
 * Every other published Fitbit route is a tombstone: the proxy answers 410
 * with `route.retired`, so a build that still calls one stops retrying.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RETIRED_ROUTE_ERROR_CODE } from "@/lib/http/retired-routes";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

vi.mock("@/lib/process-type", () => ({
  shouldRunWeb: () => true,
  shouldRunWorker: () => false,
}));

const prisma = () => getPrismaClient();

beforeEach(async () => {
  await truncateAllTables(prisma());
  cookieJar.clear();
  headerJar.clear();
});

describe("GET /api/fitbit/status", () => {
  it("answers 200 in the old shape: not connected, retired", async () => {
    const user = await prisma().user.create({
      data: { username: "fitbit-app", email: "fitbit-app@example.test" },
    });
    const session = await prisma().session.create({
      data: { userId: user.id, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    cookieJar.set("healthlog_session", session.id);

    const { GET } = await import("@/app/api/fitbit/status/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { connected: false, configured: false, retired: true },
      error: null,
    });
  });

  it("still asks for a signed-in caller", async () => {
    const { GET } = await import("@/app/api/fitbit/status/route");
    expect((await GET()).status).toBe(401);
  });
});

describe("the other Fitbit routes", () => {
  it.each([
    ["/api/fitbit/credentials", "GET"],
    ["/api/fitbit/credentials", "PUT"],
    ["/api/fitbit/credentials", "DELETE"],
    ["/api/fitbit/disconnect", "POST"],
    ["/api/fitbit/sync", "POST"],
    ["/api/integrations/fitbit/resume", "POST"],
    ["/api/integrations/fitbit/test", "POST"],
  ])("%s %s answers 410 route.retired", async (path, method) => {
    const { proxy } = await import("@/proxy");
    const res = proxy(new NextRequest(`http://localhost${path}`, { method }));
    expect(res.status).toBe(410);
    const body = (await res.json()) as {
      data: null;
      meta: { errorCode: string; removedIn: string };
    };
    expect(body.data).toBeNull();
    expect(body.meta.errorCode).toBe(RETIRED_ROUTE_ERROR_CODE);
    expect(body.meta.removedIn).toBe("1.48.0");
  });
});

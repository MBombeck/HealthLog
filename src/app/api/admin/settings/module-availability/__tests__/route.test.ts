import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
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

import { GET, PATCH } from "../route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

const ADMIN_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "admin-1", username: "testuser", role: "ADMIN" as const },
};
const USER_OK = {
  session: { id: "sess-2", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "bob", role: "USER" as const },
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/admin/settings/module-availability", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await (GET as unknown as (r: NextRequest) => Promise<Response>)(
      new NextRequest(
        "http://localhost/api/admin/settings/module-availability",
      ),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller is not an admin (cookie-only boundary)", async () => {
    vi.mocked(getSession).mockResolvedValue(USER_OK as never);
    const res = await (GET as unknown as (r: NextRequest) => Promise<Response>)(
      new NextRequest(
        "http://localhost/api/admin/settings/module-availability",
      ),
    );
    expect(res.status).toBe(403);
  });

  it("returns an all-available map for a fresh install (null column)", async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_OK as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null);
    const res = await (GET as unknown as (r: NextRequest) => Promise<Response>)(
      new NextRequest(
        "http://localhost/api/admin/settings/module-availability",
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { availability: Record<string, boolean> };
    };
    expect(body.data.availability.mood).toBe(true);
    expect(body.data.availability.coach).toBe(true);
    expect(body.data.availability.doctorReport).toBe(true);
  });

  it("reflects a persisted operator-disabled module", async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_OK as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      moduleAvailabilityJson: { mood: false },
    } as never);
    const res = await (GET as unknown as (r: NextRequest) => Promise<Response>)(
      new NextRequest(
        "http://localhost/api/admin/settings/module-availability",
      ),
    );
    const body = (await res.json()) as {
      data: { availability: Record<string, boolean> };
    };
    expect(body.data.availability.mood).toBe(false);
    expect(body.data.availability.sleep).toBe(true);
  });
});

describe("PATCH /api/admin/settings/module-availability", () => {
  function patchReq(payload: object) {
    return new NextRequest(
      "http://localhost/api/admin/settings/module-availability",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
  }

  it("returns 403 to a non-admin caller", async () => {
    vi.mocked(getSession).mockResolvedValue(USER_OK as never);
    const res = await PATCH(patchReq({ mood: false }));
    expect(res.status).toBe(403);
  });

  it("disables a module server-wide and echoes the resolved map", async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_OK as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.appSettings.upsert).mockResolvedValue({
      moduleAvailabilityJson: { mood: false },
    } as never);

    const res = await PATCH(patchReq({ mood: false }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { availability: Record<string, boolean> };
    };
    expect(body.data.availability.mood).toBe(false);
    expect(body.data.availability.glucose).toBe(true);
  });

  it("merges onto the existing blob (partial patch keeps other keys)", async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_OK as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      moduleAvailabilityJson: { sleep: false },
    } as never);
    vi.mocked(prisma.appSettings.upsert).mockResolvedValue({
      moduleAvailabilityJson: { sleep: false, mood: false },
    } as never);

    const res = await PATCH(patchReq({ mood: false }));
    expect(res.status).toBe(200);
    // The upsert must carry BOTH the pre-existing sleep:false and the new
    // mood:false — the partial patch never drops untouched keys.
    const upsertArg = vi.mocked(prisma.appSettings.upsert).mock.calls[0][0];
    expect(
      (upsertArg.update as { moduleAvailabilityJson: Record<string, boolean> })
        .moduleAvailabilityJson,
    ).toEqual({ sleep: false, mood: false });
  });

  it("rejects an empty body", async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_OK as never);
    const res = await PATCH(patchReq({}));
    expect(res.status).toBe(422);
  });

  it("rejects a core domain key strictly (weight can never be disabled)", async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_OK as never);
    const res = await PATCH(patchReq({ weight: false }));
    expect(res.status).toBe(422);
  });

  it("rejects an unknown module key strictly", async () => {
    vi.mocked(getSession).mockResolvedValue(ADMIN_OK as never);
    const res = await PATCH(patchReq({ potato: false }));
    expect(res.status).toBe(422);
  });
});

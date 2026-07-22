import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    biomarker: { findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/idempotency", () => ({
  withIdempotency:
    <Args extends unknown[]>(fn: (...args: Args) => Promise<Response>) =>
    (...args: Args) =>
      fn(...args),
}));
vi.mock("@/lib/labs/biomarker-store", () => ({
  decryptContextSoft: vi.fn(),
  encryptContextToBytes: vi.fn(),
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

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION = {
  session: { id: "s1", expiresAt: new Date(Date.now() + 60_000) },
  user: { id: "u1", username: "user", role: "USER" as const },
};

function req(body: unknown) {
  return new NextRequest("http://localhost/api/biomarkers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
});

describe("biomarker create error contract", () => {
  it("pins validation failures", async () => {
    const res = await POST(req({ name: "" }));
    expect(res.status).toBe(422);
    expect((await res.json()).meta?.errorCode).toBe(
      "labs.biomarker.create.invalid",
    );
  });

  it("pins duplicate-name conflicts", async () => {
    vi.mocked(prisma.biomarker.findFirst).mockResolvedValue({
      id: "bm-existing",
    } as never);
    const res = await POST(req({ name: "LDL", unit: "mg/dL" }));
    expect(res.status).toBe(409);
    expect((await res.json()).meta?.errorCode).toBe("labs.biomarker.duplicate");
  });
});

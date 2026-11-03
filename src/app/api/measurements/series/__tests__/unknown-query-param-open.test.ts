/**
 * The other half of the strictness decision, asserted rather than
 * assumed.
 *
 * `measurements/series` is one of the read filters left deliberately
 * open (see `src/app/api/__tests__/inline-schema-strictness-inventory.test.ts`).
 * It parses the WHOLE `searchParams`, so an unknown param does reach the
 * schema — and it has to keep being ignored. This is the iOS chart
 * loader's hot path; a 422 here paints an error banner over a chart that
 * would otherwise have rendered, and a stray param discards nothing,
 * because the filter the caller asked for is still applied.
 *
 * Without this test, a later "add .strict() everywhere" sweep would take
 * the tolerance away and the only thing that noticed would be a user.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
    $queryRaw: vi.fn(),
    $queryRawUnsafe: vi.fn(),
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/tz/resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tz/resolver")>();
  return { ...actual, resolveUserTimezone: vi.fn(async () => "UTC") };
});

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/rollups/measurement-read", () => ({
  loadUserSourcePriority: vi.fn(async () => null),
}));

vi.mock("@/lib/logging/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging/context")>();
  return { ...actual, annotate: vi.fn() };
});

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

function req(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/measurements/series?${query}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
  vi.mocked(prisma.$queryRawUnsafe).mockResolvedValue([] as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    glucoseUnit: "mg/dL",
  } as never);
});

describe("GET /api/measurements/series — undeclared query params", () => {
  it("serves the series when an undeclared param rides along", async () => {
    const res = await GET(req("kind=weight&days=30&cacheBust=1757000000"));
    expect(res.status).toBe(200);
  });

  it("serves the same series with and without the stray param", async () => {
    const clean = await (await GET(req("kind=weight&days=30"))).json();
    const noisy = await (
      await GET(req("kind=weight&days=30&utm_source=mail&t=42"))
    ).json();
    expect(noisy).toEqual(clean);
  });

  it("still refuses a param it DOES declare when the value is wrong", async () => {
    // Tolerating unknown keys is not tolerating unknown values: the
    // closed `kind` enum keeps rejecting.
    const res = await GET(req("kind=garbage&stray=1"));
    expect(res.status).toBe(422);
  });
});

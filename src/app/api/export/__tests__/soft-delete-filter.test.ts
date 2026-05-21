/**
 * v1.4.41 W-DELETED-2 — pin soft-delete invisibility across the remaining
 * reader tiers that W-DELETED-1 (v1.4.40) did not cover:
 *   - /api/export (legacy CSV/JSON endpoint),
 *   - /api/export/full-backup (single-file JSON bundle),
 *   - /api/export/measurements (per-type CSV),
 *   - /api/doctor-report/availability (section probe),
 *   - /api/gamification/achievements (achievement progress aggregator).
 *
 * Every assertion is shape-level: the route's measurement read MUST scope
 * to `deletedAt: null` so an iOS undo, a pending-sync row, or a server-
 * side admin delete never reaches the user's downloaded file / PDF /
 * badge state. We do not exercise the full DB; mocks are enough because
 * Prisma's `where` is the contract under test here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn(), count: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn(), count: vi.fn() },
    moodEntry: { findMany: vi.fn(), count: vi.fn() },
    user: { findUnique: vi.fn() },
    passkey: { findMany: vi.fn() },
    apiToken: { count: vi.fn() },
    session: { count: vi.fn() },
    appSettings: { findUnique: vi.fn() },
    userAchievement: {
      findMany: vi.fn(),
      createMany: vi.fn(),
    },
    auditEvent: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  requireAuth: vi.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/geo", () => ({ lookupIpLocation: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({
  emitStructuredLog: vi.fn(),
}));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn().mockResolvedValue("Europe/Berlin"),
}));

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";

const SESSION_OK = {
  user: {
    id: "user-1",
    email: "test@example.com",
    role: "USER",
  },
} as const;

function mkReq(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 9,
    resetAt: Date.now() + 3_600_000,
  });
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.measurement.count).mockResolvedValue(0);
  vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.medicationIntakeEvent.count).mockResolvedValue(0);
  vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.moodEntry.count).mockResolvedValue(0);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ heightCm: null } as never);
});

describe("v1.4.41 W-DELETED-2 — soft-delete invisibility", () => {
  it("/api/export/measurements scopes the read to deletedAt: null", async () => {
    const { GET } = await import("../measurements/route");
    await GET(mkReq("http://localhost/api/export/measurements"));
    expect(prisma.measurement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: null }),
      }),
    );
  });

  it("/api/export/full-backup scopes the measurement read to deletedAt: null", async () => {
    const { GET } = await import("../full-backup/route");
    await GET(mkReq("http://localhost/api/export/full-backup"));
    expect(prisma.measurement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: null }),
      }),
    );
  });

  it("/api/export (legacy) scopes the measurement read to deletedAt: null", async () => {
    const { GET } = await import("../route");
    await GET(mkReq("http://localhost/api/export?type=measurements"));
    expect(prisma.measurement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: null }),
      }),
    );
  });

  it("/api/gamification/achievements scopes the measurement read to deletedAt: null", async () => {
    vi.mocked(prisma.userAchievement.findMany).mockResolvedValue([] as never);
    const { GET } = await import(
      "../../gamification/achievements/route"
    );
    await GET(mkReq("http://localhost/api/gamification/achievements"));
    const calls = vi.mocked(prisma.measurement.findMany).mock.calls;
    // The achievement aggregator reads recent measurements via
    // findMany — a tombstoned row must never count toward a streak
    // or PR badge.
    expect(calls.length).toBeGreaterThan(0);
    for (const [arg] of calls) {
      expect(arg).toMatchObject({
        where: expect.objectContaining({ deletedAt: null }),
      });
    }
  });

  it("/api/doctor-report/availability scopes every measurement count to deletedAt: null", async () => {
    const { POST } = await import(
      "../../doctor-report/availability/route"
    );
    const req = new NextRequest(
      "http://localhost/api/doctor-report/availability",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    await POST(req);
    const calls = vi.mocked(prisma.measurement.count).mock.calls;
    // The probe runs four parallel measurement.count queries (BP /
    // weight / pulse / sleep). All must filter tombstoned rows so a
    // soft-deleted history does not light up a section the user has
    // since wiped.
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const [arg] of calls) {
      expect(arg).toMatchObject({
        where: expect.objectContaining({ deletedAt: null }),
      });
    }
  });
});

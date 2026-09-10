/**
 * v1.4.41 W-DELETED-2 — pin soft-delete invisibility across the remaining
 * reader tiers that W-DELETED-1 (v1.4.40) did not cover:
 *   - /api/export (legacy CSV/JSON endpoint),
 *   - /api/export/full-backup (single-file JSON bundle),
 *   - /api/export/measurements (per-type CSV),
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
    // v1.28.25 — the achievements vitals read is a raw (day, hour, type)
    // bucket aggregation.
    $queryRaw: vi.fn(),
    measurement: { findMany: vi.fn(), count: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn(), count: vi.fn() },
    moodEntry: { findMany: vi.fn(), count: vi.fn() },
    moodTag: { findMany: vi.fn() },
    moodTagCategory: { findMany: vi.fn() },
    moodTagHidden: { findMany: vi.fn() },
    mentalHealthAssessment: { findMany: vi.fn() },
    consentReceipt: { findMany: vi.fn() },
    nutrientIntakeDay: { findMany: vi.fn().mockResolvedValue([]) },
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
    // v1.28.25 — the achievements aggregation previously aborted mid-flight
    // on this mock (no `auditLog` model), which the old assertion masked
    // because the vitals findMany fired before the abort. With the vitals
    // read on `$queryRaw`, the sleep findMany the assertion now pins runs
    // AFTER these models — mock them so the aggregation completes.
    auditLog: { findMany: vi.fn() },
    userHealthProfile: { findUnique: vi.fn() },
    illnessEpisode: { findMany: vi.fn() },
    // v1.28 backup-completeness — the cycle + records sections the
    // full-backup builder now also reads (`buildCycleBackupSection` /
    // `buildRecordsBackupSection`).
    cycleProfile: { findUnique: vi.fn() },
    menstrualCycle: { findMany: vi.fn() },
    cycleDayLog: { findMany: vi.fn() },
    labResult: { findMany: vi.fn() },
    biomarker: { findMany: vi.fn() },
    allergy: { findMany: vi.fn() },
    familyHistoryEntry: { findMany: vi.fn() },
    workout: { findMany: vi.fn() },
    inboundDocument: { findMany: vi.fn() },
    // What a document was filed against, and what was read out of it.
    documentConditionLink: { findMany: vi.fn() },
    extractedFact: { findMany: vi.fn() },
    ecgRecording: { findMany: vi.fn() },
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

// v1.18.0 — the achievements route gates on `requireModuleEnabled`. Stub
// the gate to "all modules enabled" (an empty map ⇒ default-on) so this
// pre-existing soft-delete test doesn't stand up the real gate's DB reads.
vi.mock("@/lib/modules/gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/modules/gate")>();
  return {
    ...actual,
    resolveModuleMap: vi.fn(),
    isModuleEnabled: vi.fn(),
    requireModuleEnabled: vi.fn(),
  };
});

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  resolveModuleMap,
  isModuleEnabled,
  requireModuleEnabled,
} from "@/lib/modules/gate";

const SESSION_OK = {
  session: {
    id: "session-1",
    expiresAt: new Date(Date.now() + 3_600_000),
    actingAsUserId: null,
  },
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
  vi.mocked(resolveModuleMap).mockResolvedValue({} as never);
  vi.mocked(isModuleEnabled).mockResolvedValue(true);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true } as never);
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    limit: 60,
    remaining: 9,
    resetAt: Date.now() + 3_600_000,
  });
  vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.measurement.count).mockResolvedValue(0);
  vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.medicationIntakeEvent.count).mockResolvedValue(0);
  vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.moodTag.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.moodTagCategory.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.moodTagHidden.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.mentalHealthAssessment.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.consentReceipt.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.moodEntry.count).mockResolvedValue(0);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    heightCm: null,
  } as never);
  vi.mocked(prisma.passkey.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.auditLog.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.userHealthProfile.findUnique).mockResolvedValue(
    null as never,
  );
  vi.mocked(prisma.illnessEpisode.findMany).mockResolvedValue([] as never);
  // v1.28 backup-completeness — the full-backup route now also reads the
  // cycle + records sections; let them resolve to empty so the route
  // completes instead of rejecting on an unmocked delegate.
  vi.mocked(prisma.cycleProfile.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.menstrualCycle.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.cycleDayLog.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.labResult.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.biomarker.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.allergy.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.familyHistoryEntry.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.workout.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.inboundDocument.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.documentConditionLink.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.extractedFact.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.ecgRecording.findMany).mockResolvedValue([] as never);
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

  it("/api/export/full-backup scopes every v1.28 records domain to userId + deletedAt: null", async () => {
    const { GET } = await import("../full-backup/route");
    await GET(mkReq("http://localhost/api/export/full-backup"));

    expect(prisma.labResult.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", deletedAt: null },
      }),
    );
    expect(prisma.illnessEpisode.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", deletedAt: null },
      }),
    );
    expect(prisma.allergy.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", deletedAt: null },
      }),
    );
    expect(prisma.familyHistoryEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", deletedAt: null },
      }),
    );
    expect(prisma.inboundDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", deletedAt: null },
      }),
    );
    // Biomarker + Workout carry no soft-delete tombstone — userId-only scope.
    expect(prisma.biomarker.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
    expect(prisma.workout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
    // The document read must never select the encrypted content blob.
    const documentCall = vi.mocked(prisma.inboundDocument.findMany).mock
      .calls[0][0] as { select?: Record<string, unknown> };
    expect(documentCall.select).not.toHaveProperty("contentEncrypted");
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
    const { GET } = await import("../../gamification/achievements/route");
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
    // v1.28.25 — the vitals read moved to a raw (day, hour, type) bucket
    // aggregation; the soft-delete scope must survive on that path too.
    const rawCalls = vi.mocked(prisma.$queryRaw).mock.calls;
    expect(rawCalls.length).toBeGreaterThan(0);
    for (const [strings] of rawCalls) {
      expect((strings as unknown as readonly string[]).join("?")).toContain(
        `"deleted_at" IS NULL`,
      );
    }
  });
});

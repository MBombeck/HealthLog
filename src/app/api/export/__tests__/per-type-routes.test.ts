/**
 * Unit-level smoke for the per-type export endpoints
 * (`/api/export/{measurements,medications,mood}` and
 * `/api/export/full-backup`).
 *
 * Exercises the auth gate, content-type, content-disposition, audit-log
 * action name, and rate-limit wiring. The full DB round-trip lives in
 * the integration suite (`tests/integration/export-per-type.test.ts`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/geo", () => ({
  lookupIpLocation: vi.fn(),
}));

vi.mock("@/lib/logging/transports", () => ({
  emitIfSampled: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { auditLog } from "@/lib/auth/audit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3600_000) },
  user: { id: "user-1", role: "USER" as const },
};

function mkReq(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/export/measurements", () => {
  it("rejects unauthenticated requests with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const { GET } = await import("../measurements/route");
    const res = await GET(mkReq("http://localhost/api/export/measurements"));
    expect(res.status).toBe(401);
  });

  it("returns text/csv with attachment disposition on success", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAt: Date.now() + 3600_000,
    });
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      {
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: new Date("2026-05-01T08:00:00.000Z"),
        source: "MANUAL",
        notes: null,
        glucoseContext: null,
      },
    ] as never);

    const { GET } = await import("../measurements/route");
    const res = await GET(mkReq("http://localhost/api/export/measurements"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="healthlog-measurements-/,
    );
    expect(res.headers.get("content-disposition")).toMatch(/\.csv"/);
    const body = await res.text();
    expect(body).toContain("WEIGHT,80,kg");

    expect(auditLog).toHaveBeenCalledWith(
      "user.export.measurements",
      expect.objectContaining({
        userId: "user-1",
      }),
    );
  });

  it("honours since/until query params via measuredAt range", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAt: Date.now() + 3600_000,
    });
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);

    const { GET } = await import("../measurements/route");
    await GET(
      mkReq(
        "http://localhost/api/export/measurements?since=2026-04-01&until=2026-05-01",
      ),
    );
    expect(prisma.measurement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          measuredAt: expect.objectContaining({
            gte: new Date("2026-04-01"),
            lte: new Date("2026-05-01"),
          }),
        }),
      }),
    );
  });
});

describe("GET /api/export/medications", () => {
  it("rejects unauthenticated requests with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const { GET } = await import("../medications/route");
    const res = await GET(mkReq("http://localhost/api/export/medications"));
    expect(res.status).toBe(401);
  });

  it("appends intake-history section when intake=true", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAt: Date.now() + 3600_000,
    });
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      {
        name: "Aspirin",
        dose: "100mg",
        active: true,
        schedules: [
          {
            windowStart: "08:00",
            windowEnd: "09:00",
            label: "Morning",
            dose: null,
          },
        ],
      },
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
      {
        medication: { name: "Aspirin" },
        scheduledFor: new Date("2026-05-01T08:00:00.000Z"),
        takenAt: new Date("2026-05-01T08:05:00.000Z"),
        skipped: false,
        source: "WEB",
      },
    ] as never);

    const { GET } = await import("../medications/route");
    const res = await GET(
      mkReq("http://localhost/api/export/medications?intake=true"),
    );
    const body = await res.text();
    expect(body).toContain("Aspirin");
    // The intake-history section is delimited so a downstream tool can split.
    expect(body).toContain("# Intake history");
    expect(body).toContain("scheduledFor");
  });

  it("omits intake-history section when intake=false", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAt: Date.now() + 3600_000,
    });
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      { name: "X", dose: "1", active: true, schedules: [] },
    ] as never);

    const { GET } = await import("../medications/route");
    const res = await GET(
      mkReq("http://localhost/api/export/medications?intake=false"),
    );
    const body = await res.text();
    expect(body).not.toContain("# Intake history");
    expect(prisma.medicationIntakeEvent.findMany).not.toHaveBeenCalled();
  });

  it("scopes both queries to a single medication when medicationId is set", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAt: Date.now() + 3600_000,
    });
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      { name: "Aspirin", dose: "100mg", active: true, schedules: [] },
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );

    const { GET } = await import("../medications/route");
    const res = await GET(
      mkReq(
        "http://localhost/api/export/medications?intake=true&medicationId=med-9",
      ),
    );
    expect(res.status).toBe(200);
    // The medication list is narrowed by id AND userId (IDOR-safe).
    expect(prisma.medication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", id: "med-9" },
      }),
    );
    // The intake history is filtered to the same medication.
    expect(prisma.medicationIntakeEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ medicationId: "med-9" }),
      }),
    );
  });

  it("404s a scoped export when the medication is not the caller's", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAt: Date.now() + 3600_000,
    });
    // userId-narrowed query resolves to no row for a foreign id.
    vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);

    const { GET } = await import("../medications/route");
    const res = await GET(
      mkReq("http://localhost/api/export/medications?medicationId=not-mine"),
    );
    expect(res.status).toBe(404);
    expect(prisma.medicationIntakeEvent.findMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/export/mood", () => {
  it("rejects unauthenticated requests with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const { GET } = await import("../mood/route");
    const res = await GET(mkReq("http://localhost/api/export/mood"));
    expect(res.status).toBe(401);
  });

  it("returns text/csv with mood rows on success", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAt: Date.now() + 3600_000,
    });
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([
      {
        date: "2026-05-01",
        mood: "good",
        score: 4,
        tags: null,
        source: "WEB",
        moodLoggedAt: new Date("2026-05-01T20:00:00.000Z"),
      },
    ] as never);

    const { GET } = await import("../mood/route");
    const res = await GET(mkReq("http://localhost/api/export/mood"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    const body = await res.text();
    expect(body).toContain("good");
    expect(auditLog).toHaveBeenCalledWith(
      "user.export.mood",
      expect.objectContaining({ userId: "user-1" }),
    );
  });
});

describe("GET /api/export/full-backup", () => {
  it("rejects unauthenticated requests with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const { GET } = await import("../full-backup/route");
    const res = await GET(mkReq("http://localhost/api/export/full-backup"));
    expect(res.status).toBe(401);
  });

  it("returns a JSON backup that matches the canonical schema", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAt: Date.now() + 3600_000,
    });
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);

    const { GET } = await import("../full-backup/route");
    const res = await GET(mkReq("http://localhost/api/export/full-backup"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="healthlog-backup-/,
    );
    expect(res.headers.get("content-disposition")).toMatch(/\.json"/);
    const json = await res.json();
    expect(json).toMatchObject({
      schemaVersion: "1",
      userId: "user-1",
      measurements: [],
      medications: [],
      intakeEvents: [],
      moodEntries: [],
    });
    expect(typeof json.exportedAt).toBe("string");
    expect(auditLog).toHaveBeenCalledWith(
      "user.export.full-backup",
      expect.objectContaining({ userId: "user-1" }),
    );
  });
});

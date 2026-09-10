/**
 * Unit-level smoke for the per-type export endpoints
 * (`/api/export/{measurements,medications,mood}` and
 * `/api/export/full-backup`).
 *
 * Exercises the auth gate, content-type, content-disposition, audit-log
 * action name, and rate-limit wiring. The full DB round-trip lives in
 * the integration suite (`tests/integration/export-per-type.test.ts`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
    moodTag: { findMany: vi.fn() },
    nutrientIntakeDay: { findMany: vi.fn().mockResolvedValue([]) },
    // Durable self-context + user-defined metrics, read by
    // `buildProfileBackupSection`.
    userHealthProfile: { findUnique: vi.fn().mockResolvedValue(null) },
    healthProfileFactRevision: { findMany: vi.fn().mockResolvedValue([]) },
    customMetric: { findMany: vi.fn().mockResolvedValue([]) },
    correlationPattern: { findMany: vi.fn().mockResolvedValue([]) },
    // The hourly shape of a cumulative day, read by
    // `buildIntradayProfileBackupSection`.
    intradayCumulativeProfile: { findMany: vi.fn().mockResolvedValue([]) },
    healthScoreRecord: { findMany: vi.fn().mockResolvedValue([]) },
    onboardingRecord: { findUnique: vi.fn().mockResolvedValue(null) },
    // The visit tables. Empty here: this file asserts the sections it seeds,
    // and an account with no visits is the ordinary case the builder must
    // still answer for.
    practitioner: { findMany: vi.fn().mockResolvedValue([]) },
    encounter: { findMany: vi.fn().mockResolvedValue([]) },
    encounterDocumentLink: { findMany: vi.fn().mockResolvedValue([]) },
    encounterLabLink: { findMany: vi.fn().mockResolvedValue([]) },
    encounterConditionLink: { findMany: vi.fn().mockResolvedValue([]) },
    vaccinationRecord: { findMany: vi.fn().mockResolvedValue([]) },
    vaccinationDocumentLink: { findMany: vi.fn().mockResolvedValue([]) },
    // The reminder engine tables (v1.37.20, #223 / iOS #68). Empty for the
    // same reason as the visit tables above.
    measurementReminder: { findMany: vi.fn().mockResolvedValue([]) },
    measurementReminderEvent: { findMany: vi.fn().mockResolvedValue([]) },
    // The bests, the badges, and the environmental history with the location
    // periods that explain it. Empty for the same reason as the tables above.
    personalRecord: { findMany: vi.fn().mockResolvedValue([]) },
    userAchievement: { findMany: vi.fn().mockResolvedValue([]) },
    environmentContext: { findMany: vi.fn().mockResolvedValue([]) },
    environmentTravelLocation: { findMany: vi.fn().mockResolvedValue([]) },
    coachConversation: { findMany: vi.fn().mockResolvedValue([]) },
    moodTagCategory: { findMany: vi.fn().mockResolvedValue([]) },
    moodTagHidden: { findMany: vi.fn().mockResolvedValue([]) },
    mentalHealthAssessment: { findMany: vi.fn().mockResolvedValue([]) },
    consentReceipt: { findMany: vi.fn().mockResolvedValue([]) },
    coachFact: { findMany: vi.fn().mockResolvedValue([]) },
    coachPlan: { findMany: vi.fn().mockResolvedValue([]) },
    coachReminder: { findMany: vi.fn().mockResolvedValue([]) },
    // What a document was filed against, and what was read out of it.
    // Empty for the same reason as the sections above.
    documentConditionLink: { findMany: vi.fn().mockResolvedValue([]) },
    extractedFact: { findMany: vi.fn().mockResolvedValue([]) },
    ecgRecording: { findMany: vi.fn().mockResolvedValue([]) },
    // v1.15.0 — cycle tables read by the full-backup helper.
    cycleProfile: { findUnique: vi.fn() },
    menstrualCycle: { findMany: vi.fn() },
    cycleDayLog: { findMany: vi.fn() },
    cycleSymptom: { findMany: vi.fn() },
    // v1.28 backup-completeness — the records section the full-backup
    // helper now also reads (`buildRecordsBackupSection`).
    labResult: { findMany: vi.fn() },
    biomarker: { findMany: vi.fn() },
    illnessEpisode: { findMany: vi.fn() },
    allergy: { findMany: vi.fn() },
    familyHistoryEntry: { findMany: vi.fn() },
    workout: { findMany: vi.fn() },
    inboundDocument: { findMany: vi.fn() },
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
  // `resetAllMocks` clears the inline defaults, and the full-backup payload
  // builder reads these unconditionally.
  vi.mocked(prisma.nutrientIntakeDay.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.userHealthProfile.findUnique).mockResolvedValue(
    null as never,
  );
  vi.mocked(prisma.healthProfileFactRevision.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.customMetric.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.correlationPattern.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.intradayCumulativeProfile.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.healthScoreRecord.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.practitioner.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.encounter.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.encounterDocumentLink.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.encounterLabLink.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.encounterConditionLink.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.vaccinationRecord.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.vaccinationDocumentLink.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.measurementReminder.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.measurementReminderEvent.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.coachConversation.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.coachFact.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.coachPlan.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.coachReminder.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.ecgRecording.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.moodTagCategory.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.moodTagHidden.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.mentalHealthAssessment.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.consentReceipt.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.documentConditionLink.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.extractedFact.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.personalRecord.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.userAchievement.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.environmentContext.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.environmentTravelLocation.findMany).mockResolvedValue(
    [] as never,
  );
});

afterEach(() => {
  // The v1.28 records-domain end-to-end test stubs ENCRYPTION_KEY to
  // exercise the real crypto path; unstub unconditionally (harmless no-op
  // for every other test) so a stub never leaks past its own test.
  vi.unstubAllEnvs();
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
      limit: 60,
      remaining: 9,
      resetAt: Date.now() + 3600_000,
    });
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      {
        id: "measurement-weight-1",
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
      limit: 60,
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

  // v1.16.16 — glucose unit-at-source. A mmol/L-preference user's CSV emits
  // BLOOD_GLUCOSE converted (100 → 5.5) with `mmol/L` in the unit column.
  it("exports BLOOD_GLUCOSE in the user's mmol/L preference", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      limit: 60,
      remaining: 9,
      resetAt: Date.now() + 3600_000,
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      glucoseUnit: "mmol/L",
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      {
        id: "measurement-glucose-mmol",
        type: "BLOOD_GLUCOSE",
        value: 100,
        unit: "mg/dL",
        measuredAt: new Date("2026-05-01T08:00:00.000Z"),
        source: "MANUAL",
        notes: null,
        glucoseContext: "FASTING",
      },
    ] as never);

    const { GET } = await import("../measurements/route");
    const res = await GET(mkReq("http://localhost/api/export/measurements"));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("BLOOD_GLUCOSE,5.5,mmol/L");
    expect(body).not.toContain("100,mg/dL");
  });

  it("exports BLOOD_GLUCOSE in raw mg/dL for a mg/dL-preference user", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      limit: 60,
      remaining: 9,
      resetAt: Date.now() + 3600_000,
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      glucoseUnit: "mg/dL",
    } as never);
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      {
        id: "measurement-glucose-mgdl",
        type: "BLOOD_GLUCOSE",
        value: 100,
        unit: "mg/dL",
        measuredAt: new Date("2026-05-01T08:00:00.000Z"),
        source: "MANUAL",
        notes: null,
        glucoseContext: "FASTING",
      },
    ] as never);

    const { GET } = await import("../measurements/route");
    const res = await GET(mkReq("http://localhost/api/export/measurements"));
    const body = await res.text();
    expect(body).toContain("BLOOD_GLUCOSE,100,mg/dL");
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
      limit: 60,
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
      limit: 60,
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
      limit: 60,
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
      limit: 60,
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
      limit: 60,
      remaining: 9,
      resetAt: Date.now() + 3600_000,
    });
    vi.mocked(prisma.moodTag.findMany).mockResolvedValue([] as never);
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
      limit: 60,
      remaining: 9,
      resetAt: Date.now() + 3600_000,
    });
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.moodTag.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.cycleProfile.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.menstrualCycle.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.cycleDayLog.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.cycleSymptom.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.labResult.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.biomarker.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.illnessEpisode.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.allergy.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.familyHistoryEntry.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.workout.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.inboundDocument.findMany).mockResolvedValue([] as never);

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
      schemaVersion: "2",
      userId: "user-1",
      measurements: [],
      medications: [],
      intakeEvents: [],
      moodEntries: [],
      // v1.28 backup-completeness — the newer domains round-trip to empty
      // arrays (not undefined/missing) when the account has no records,
      // and the manifest still discloses the two deliberate exclusions.
      labResults: [],
      biomarkers: [],
      illnessEpisodes: [],
      allergies: [],
      familyHistory: [],
      workouts: [],
      documents: [],
      manifest: {
        documents: { included: "metadata-only" },
        workouts: { included: "summary-only" },
      },
    });
    expect(typeof json.exportedAt).toBe("string");
    expect(auditLog).toHaveBeenCalledWith(
      "user.export.full-backup",
      expect.objectContaining({ userId: "user-1" }),
    );
  });

  it("includes decrypted v1.28 records-domain data end-to-end", async () => {
    vi.stubEnv("ENCRYPTION_KEYS", "");
    vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
    vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));

    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      limit: 60,
      remaining: 9,
      resetAt: Date.now() + 3600_000,
    });
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.moodTag.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.cycleProfile.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.menstrualCycle.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.cycleDayLog.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.cycleSymptom.findMany).mockResolvedValue([] as never);

    const { encryptToBytes } = await import("@/lib/ai/coach/bytes-codec");
    vi.mocked(prisma.labResult.findMany).mockResolvedValue([
      {
        panel: null,
        analyte: "HbA1c",
        value: 5.4,
        valueText: null,
        unit: "%",
        referenceLow: null,
        referenceHigh: null,
        takenAt: new Date("2026-04-01T09:00:00.000Z"),
        source: "MANUAL",
        biomarker: null,
        noteEncrypted: null,
      },
    ] as never);
    vi.mocked(prisma.biomarker.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.illnessEpisode.findMany).mockResolvedValue([
      {
        id: "ep-1",
        label: "Migraine flare",
        type: "CHRONIC",
        lifecycle: "FLARE",
        onsetAt: new Date("2026-04-10T00:00:00.000Z"),
        resolvedAt: null,
        parentConditionId: "ep-parent",
        noteEncrypted: encryptToBytes("Triggered by travel."),
        createdAt: new Date("2026-04-10T00:00:00.000Z"),
        updatedAt: new Date("2026-04-10T00:00:00.000Z"),
        dayLogs: [],
      },
    ] as never);
    vi.mocked(prisma.allergy.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.familyHistoryEntry.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.workout.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.inboundDocument.findMany).mockResolvedValue([] as never);

    const { GET } = await import("../full-backup/route");
    const res = await GET(mkReq("http://localhost/api/export/full-backup"));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.labResults).toEqual([
      expect.objectContaining({ analyte: "HbA1c", value: 5.4 }),
    ]);
    // The flare's parent link + decrypted note round-trip in the JSON —
    // never the ciphertext.
    expect(json.illnessEpisodes[0].parentConditionId).toBe("ep-parent");
    expect(json.illnessEpisodes[0].note).toBe("Triggered by travel.");
    // The raw ciphertext column never leaves the server — only the
    // decrypted `note` field is present on the DTO.
    expect(json.illnessEpisodes[0]).not.toHaveProperty("noteEncrypted");
  });
});

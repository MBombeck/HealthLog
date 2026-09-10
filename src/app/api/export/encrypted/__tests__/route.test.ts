/**
 * v1.23 — POST /api/export/encrypted unit coverage.
 *
 * Mock-based. Pins the step-up gating contract (single-factor accounts export
 * without step-up; MFA accounts need a fresh second factor) and that the
 * passphrase produces a decryptable HLX1 archive — never a plaintext body.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn().mockResolvedValue([]) },
    medication: { findMany: vi.fn().mockResolvedValue([]) },
    medicationIntakeEvent: { findMany: vi.fn().mockResolvedValue([]) },
    moodEntry: { findMany: vi.fn().mockResolvedValue([]) },
    moodTag: { findMany: vi.fn().mockResolvedValue([]) },
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
    cycleProfile: { findUnique: vi.fn().mockResolvedValue(null) },
    menstrualCycle: { findMany: vi.fn().mockResolvedValue([]) },
    cycleDayLog: { findMany: vi.fn().mockResolvedValue([]) },
    cycleSymptom: { findMany: vi.fn().mockResolvedValue([]) },
    // v1.28 backup-completeness — the records section the shared payload
    // builder now also reads (`buildRecordsBackupSection`).
    labResult: { findMany: vi.fn().mockResolvedValue([]) },
    biomarker: { findMany: vi.fn().mockResolvedValue([]) },
    illnessEpisode: { findMany: vi.fn().mockResolvedValue([]) },
    allergy: { findMany: vi.fn().mockResolvedValue([]) },
    familyHistoryEntry: { findMany: vi.fn().mockResolvedValue([]) },
    workout: { findMany: vi.fn().mockResolvedValue([]) },
    inboundDocument: { findMany: vi.fn().mockResolvedValue([]) },
    session: { findUnique: vi.fn() },
    webauthnMfaCredential: { count: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/geo", () => ({
  lookupIpLocation: vi.fn(),
  lookupIpAsn: vi.fn(),
}));
vi.mock("@/lib/logging/transports", () => ({ emitStructuredLog: vi.fn() }));

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { POST } from "../route";
import { decryptArchive } from "@/lib/export/passphrase-archive";

const PASSPHRASE = "a-strong-passphrase-123";

function mkReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/export/encrypted", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 9,
    reset: Date.now() + 3600_000,
  } as never);
  // Default: no registered security key. Tests that exercise the
  // WebAuthn-only cohort override this.
  vi.mocked(prisma.webauthnMfaCredential.count).mockResolvedValue(0 as never);
});

describe("POST /api/export/encrypted", () => {
  it("returns a decryptable HLX1 archive for a single-factor account", async () => {
    vi.mocked(getSession).mockResolvedValue({
      user: { id: "user-1", role: "USER", totpConfirmedAt: null },
      session: { id: "sess-1" },
    } as never);

    const res = await POST(mkReq({ passphrase: PASSPHRASE }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");

    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 4).toString("ascii")).toBe("HLX1");
    const plaintext = await decryptArchive(buf, PASSPHRASE);
    const payload = JSON.parse(plaintext);
    expect(payload).toHaveProperty("schemaVersion");
    expect(payload).toHaveProperty("measurements");
    // v1.28 backup-completeness — the encrypted archive carries the same
    // records domains as the plaintext export.
    expect(payload).toHaveProperty("labResults");
    expect(payload).toHaveProperty("illnessEpisodes");
    expect(payload).toHaveProperty("allergies");
    expect(payload).toHaveProperty("familyHistory");
    expect(payload).toHaveProperty("workouts");
    expect(payload).toHaveProperty("documents");
    expect(payload.manifest).toMatchObject({
      documents: { included: "metadata-only" },
      workouts: { included: "summary-only" },
    });
  });

  it("blocks an MFA account without a fresh second factor (401 step-up)", async () => {
    vi.mocked(getSession).mockResolvedValue({
      user: { id: "user-1", role: "USER", totpConfirmedAt: new Date() },
      session: { id: "sess-1" },
    } as never);
    // No fresh mfaVerifiedAt on the session row.
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      mfaVerifiedAt: null,
    } as never);

    const res = await POST(mkReq({ passphrase: PASSPHRASE }));
    expect(res.status).toBe(401);
  });

  it("allows an MFA account with a fresh second factor", async () => {
    vi.mocked(getSession).mockResolvedValue({
      user: { id: "user-1", role: "USER", totpConfirmedAt: new Date() },
      session: { id: "sess-1" },
    } as never);
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      mfaVerifiedAt: new Date(),
    } as never);

    const res = await POST(mkReq({ passphrase: PASSPHRASE }));
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(await decryptArchive(buf, PASSPHRASE)).toContain("schemaVersion");
  });

  it("blocks a WebAuthn-only account (no TOTP) without a fresh second factor (401 step-up)", async () => {
    // No confirmed TOTP, but a registered security key — the account is still
    // MFA-enrolled and must clear step-up before exporting the whole record.
    vi.mocked(getSession).mockResolvedValue({
      user: { id: "user-1", role: "USER", totpConfirmedAt: null },
      session: { id: "sess-1" },
    } as never);
    vi.mocked(prisma.webauthnMfaCredential.count).mockResolvedValue(1 as never);
    // No fresh mfaVerifiedAt on the session row.
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      mfaVerifiedAt: null,
    } as never);

    const res = await POST(mkReq({ passphrase: PASSPHRASE }));
    expect(res.status).toBe(401);
  });

  it("allows a WebAuthn-only account with a fresh second factor", async () => {
    vi.mocked(getSession).mockResolvedValue({
      user: { id: "user-1", role: "USER", totpConfirmedAt: null },
      session: { id: "sess-1" },
    } as never);
    vi.mocked(prisma.webauthnMfaCredential.count).mockResolvedValue(1 as never);
    vi.mocked(prisma.session.findUnique).mockResolvedValue({
      mfaVerifiedAt: new Date(),
    } as never);

    const res = await POST(mkReq({ passphrase: PASSPHRASE }));
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(await decryptArchive(buf, PASSPHRASE)).toContain("schemaVersion");
  });

  it("rejects a too-short passphrase with 422", async () => {
    vi.mocked(getSession).mockResolvedValue({
      user: { id: "user-1", role: "USER", totpConfirmedAt: null },
      session: { id: "sess-1" },
    } as never);

    const res = await POST(mkReq({ passphrase: "short" }));
    expect(res.status).toBe(422);
  });
});

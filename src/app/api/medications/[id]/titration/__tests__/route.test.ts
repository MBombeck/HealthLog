/**
 * v1.4.25 W19f — titration-ladder route tests.
 *
 * Mirrors the W19e cadence-route test fixture: external dependencies
 * are mocked at module boundaries (prisma, session, logging
 * transport) so each test pins one contract case. The pure ladder
 * helpers are covered separately in
 * `src/lib/medications/titration/__tests__/ladder.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

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

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

function makeMed(
  overrides: Partial<{
    name: string;
    dose: string;
    treatmentClass: "GLP1" | "GENERIC";
    userId: string;
    doseChanges: Array<{ effectiveFrom: Date; doseValue: number }>;
  }> = {},
) {
  return {
    id: "med-1",
    name: overrides.name ?? "Mounjaro",
    dose: overrides.dose ?? "5 mg",
    treatmentClass: overrides.treatmentClass ?? ("GLP1" as const),
    userId: overrides.userId ?? "user-1",
    createdAt: new Date(),
    doseChanges: overrides.doseChanges ?? [],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/medications/[id]/titration", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await GET(
      new NextRequest("http://localhost/api/medications/med-1/titration"),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when the medication is not owned by the caller", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(
      makeMed({ userId: "OTHER" }) as never,
    );

    const res = await GET(
      new NextRequest("http://localhost/api/medications/med-1/titration"),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the medication is not GLP-1", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(
      makeMed({ treatmentClass: "GENERIC" }) as never,
    );

    const res = await GET(
      new NextRequest("http://localhost/api/medications/med-1/titration"),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the medication brand is not in the GLP-1 catalog", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(
      makeMed({ name: "MysteryDrug" }) as never,
    );

    const res = await GET(
      new NextRequest("http://localhost/api/medications/med-1/titration"),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns the ladder + current step for a Mounjaro user on 5 mg", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(
      makeMed({
        name: "Mounjaro",
        dose: "5 mg",
        doseChanges: [
          {
            effectiveFrom: new Date(Date.now() - 6 * 7 * 24 * 60 * 60 * 1000),
            doseValue: 2.5,
          },
          {
            effectiveFrom: new Date(Date.now() - 2 * 7 * 24 * 60 * 60 * 1000),
            doseValue: 5,
          },
        ],
      }) as never,
    );

    const res = await GET(
      new NextRequest("http://localhost/api/medications/med-1/titration"),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.drugId).toBe("tirzepatide");
    expect(json.data.ladder.length).toBe(6);
    expect(json.data.currentStep.doseMg).toBe(5);
    expect(json.data.currentStepIndex).toBe(1);
    expect(json.data.weeksOnCurrentStep).toBe(2);
    expect(json.data.nextStep.doseMg).toBe(7.5);
    expect(json.data.escalationDue).toBe(false);
  });

  it("returns a null current step when the user dose is outside any ladder bucket", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(
      makeMed({
        name: "Mounjaro",
        dose: "6 mg", // outside the ±10 % window of 5 and 7.5
        doseChanges: [],
      }) as never,
    );

    const res = await GET(
      new NextRequest("http://localhost/api/medications/med-1/titration"),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.currentStep).toBeNull();
    expect(json.data.currentStepIndex).toBeNull();
    expect(json.data.nextStep).toBeNull();
    expect(json.data.escalationDue).toBe(false);
  });

  it("returns a null next-step at the ladder ceiling", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(
      makeMed({
        name: "Mounjaro",
        dose: "15 mg",
        doseChanges: [
          {
            effectiveFrom: new Date(Date.now() - 5 * 7 * 24 * 60 * 60 * 1000),
            doseValue: 15,
          },
        ],
      }) as never,
    );

    const res = await GET(
      new NextRequest("http://localhost/api/medications/med-1/titration"),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.currentStep.doseMg).toBe(15);
    expect(json.data.nextStep).toBeNull();
    expect(json.data.escalationDue).toBe(false);
  });

  it("flags escalationDue=true past the EMA dwell-time on a non-ceiling step", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue(
      makeMed({
        name: "Mounjaro",
        dose: "2.5 mg",
        doseChanges: [
          {
            // Six weeks ago, past tirzepatide's 4-week interval.
            effectiveFrom: new Date(Date.now() - 6 * 7 * 24 * 60 * 60 * 1000),
            doseValue: 2.5,
          },
        ],
      }) as never,
    );

    const res = await GET(
      new NextRequest("http://localhost/api/medications/med-1/titration"),
      { params: Promise.resolve({ id: "med-1" }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.currentStep.doseMg).toBe(2.5);
    expect(json.data.weeksOnCurrentStep).toBe(6);
    expect(json.data.escalationDue).toBe(true);
  });
});

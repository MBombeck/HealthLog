/**
 * PHQ-9 and GAD-7 scored assessments from Apple Health on the measurement
 * batch, against real Postgres.
 *
 * A screener has one home, `MentalHealthAssessment`, whichever door it came
 * through. The batch writes an Apple Health administration there with
 * `source = APPLE_HEALTH` and the sample UUID as `externalId`, plus the same
 * `COMPUTED` trend row the questionnaire writes, and never an `APPLE_HEALTH`
 * score measurement beside it: one administration is one point on the trend.
 * It shows in the screener history and detail, a re-sent or deleted sample
 * answers `duplicate`, and the module, the source and the answers are checked
 * per entry.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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

const PHQ9 = "HKScoredAssessmentTypeIdentifierPHQ9";
const GAD7 = "HKScoredAssessmentTypeIdentifierGAD7";
const PHQ9_ID = "8B2F0C1D-0000-4000-8000-0000000000A1";
const GAD7_ID = "8B2F0C1D-0000-4000-8000-0000000000A2";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function signIn(mentalHealth: boolean): Promise<string> {
  const prisma = getPrismaClient();
  const owner = await prisma.user.create({
    data: {
      username: "screener-owner",
      email: "screener-owner@example.test",
      timezone: "UTC",
      locale: "de",
      modulePreferencesJson: { mentalHealth },
    },
  });
  const session = await prisma.session.create({
    data: { userId: owner.id, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return owner.id;
}

interface BatchBody {
  data: {
    inserted: number;
    duplicates: number;
    entries: Array<{ index: number; status: string; reason?: string }>;
  };
}

async function postBatch(entries: unknown[]): Promise<BatchBody> {
  const { POST } = await import("@/app/api/measurements/batch/route");
  const res = await POST(
    new NextRequest("http://localhost/api/measurements/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries }),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as BatchBody;
}

const at = "2026-10-05T08:30:00.000Z";
const phq9 = {
  hkIdentifier: PHQ9,
  value: 7,
  unit: "count",
  startDate: at,
  endDate: at,
  externalId: PHQ9_ID,
  // Item 9 answered above zero.
  assessmentAnswers: [1, 1, 1, 1, 1, 0, 0, 1, 1],
};
const gad7 = {
  hkIdentifier: GAD7,
  value: 4,
  unit: "count",
  startDate: at,
  endDate: at,
  externalId: GAD7_ID,
};

describe("Apple Health PHQ-9 / GAD-7 on the measurement batch", () => {
  it("writes administrations with one trend row each and lists them in the screener history", async () => {
    const userId = await signIn(true);
    const prisma = getPrismaClient();

    const body = await postBatch([phq9, gad7]);
    expect(body.data.entries).toEqual([
      { index: 0, status: "inserted" },
      { index: 1, status: "inserted" },
    ]);
    expect(body.data.inserted).toBe(2);

    const rows = await prisma.mentalHealthAssessment.findMany({
      where: { userId },
      orderBy: { instrument: "asc" },
      select: {
        id: true,
        instrument: true,
        totalScore: true,
        severityBand: true,
        item9Flagged: true,
        crisisShownAt: true,
        source: true,
        externalId: true,
        locale: true,
        wording: true,
        takenAt: true,
      },
    });
    expect(rows.map(({ id: _id, ...rest }) => rest)).toEqual([
      {
        instrument: "PHQ9",
        totalScore: 7,
        severityBand: "mild",
        item9Flagged: true,
        crisisShownAt: null,
        source: "APPLE_HEALTH",
        externalId: PHQ9_ID,
        locale: "de",
        wording: null,
        takenAt: new Date(at),
      },
      {
        instrument: "GAD7",
        totalScore: 4,
        severityBand: "minimal",
        item9Flagged: false,
        crisisShownAt: null,
        source: "APPLE_HEALTH",
        externalId: GAD7_ID,
        locale: "de",
        wording: null,
        takenAt: new Date(at),
      },
    ]);

    // Exactly one trend point per administration, all COMPUTED and keyed on
    // the administration; nothing APPLE_HEALTH on the score types.
    const scores = await prisma.measurement.findMany({
      where: { userId, type: { in: ["PHQ9_SCORE", "GAD7_SCORE"] } },
      orderBy: { type: "asc" },
      select: { type: true, value: true, source: true, externalId: true },
    });
    const [phqRow, gadRow] = rows;
    expect(scores).toEqual([
      {
        type: "PHQ9_SCORE",
        value: 7,
        source: "COMPUTED",
        externalId: `assessment:${phqRow.id}`,
      },
      {
        type: "GAD7_SCORE",
        value: 4,
        source: "COMPUTED",
        externalId: `assessment:${gadRow.id}`,
      },
    ]);

    const list = await import("@/app/api/mental-health/assessments/route");
    const listRes = await list.GET(
      new NextRequest("http://localhost/api/mental-health/assessments"),
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      data: { assessments: Array<{ id: string; item9Flagged: boolean }> };
    };
    expect(listBody.data.assessments.map((a) => a.id).sort()).toEqual(
      [gadRow.id, phqRow.id].sort(),
    );

    const detail =
      await import("@/app/api/mental-health/assessments/[id]/route");
    const read = async (id: string) => {
      const res = await detail.GET(
        new NextRequest(`http://localhost/api/mental-health/assessments/${id}`),
        { params: Promise.resolve({ id }) },
      );
      expect(res.status).toBe(200);
      return (
        (await res.json()) as {
          data: {
            assessment: { items: number[] | null; itemsUnavailable: boolean };
          };
        }
      ).data.assessment;
    };
    expect(await read(phqRow.id)).toMatchObject({
      items: phq9.assessmentAnswers,
      itemsUnavailable: false,
    });
    // Score only: nothing to show, and said so.
    expect(await read(gadRow.id)).toMatchObject({
      items: null,
      itemsUnavailable: true,
    });
  });

  it("answers duplicate for a re-sent sample and for one whose administration was deleted", async () => {
    const userId = await signIn(true);
    const prisma = getPrismaClient();
    await postBatch([phq9]);
    await prisma.mentalHealthAssessment.updateMany({
      where: { userId, externalId: PHQ9_ID },
      data: { deletedAt: new Date() },
    });

    const body = await postBatch([phq9, gad7, gad7]);
    expect(body.data.entries).toEqual([
      { index: 0, status: "duplicate" },
      { index: 1, status: "inserted" },
      { index: 2, status: "duplicate" },
    ]);
    expect(
      await prisma.mentalHealthAssessment.count({ where: { userId } }),
    ).toBe(2);
    expect(
      await prisma.mentalHealthAssessment.count({
        where: { userId, deletedAt: null },
      }),
    ).toBe(1);
  });

  it("refuses per entry: module off, wrong source, bad answers, out-of-range score", async () => {
    const offUser = await signIn(false);
    const prisma = getPrismaClient();
    const off = await postBatch([phq9]);
    expect(off.data.entries).toEqual([
      { index: 0, status: "skipped", reason: "module_disabled" },
    ]);
    expect(
      await prisma.mentalHealthAssessment.count({ where: { userId: offUser } }),
    ).toBe(0);

    await prisma.user.update({
      where: { id: offUser },
      data: { modulePreferencesJson: { mentalHealth: true } },
    });
    const body = await postBatch([
      { ...phq9, source: "MANUAL" },
      { ...phq9, externalId: `${PHQ9_ID}-b`, value: 9 },
      { ...gad7, value: 22 },
      {
        hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
        value: 80,
        unit: "kg",
        startDate: at,
        endDate: at,
        externalId: "8B2F0C1D-0000-4000-8000-0000000000B1",
      },
    ]);
    expect(body.data.entries).toEqual([
      { index: 0, status: "skipped", reason: "unsupported_source" },
      { index: 1, status: "skipped", reason: "invalid_assessment_answers" },
      {
        index: 2,
        status: "skipped",
        reason: "value_out_of_range",
        range: { min: 0, max: 21, unit: "score" },
      },
      { index: 3, status: "inserted" },
    ]);
    expect(
      await prisma.mentalHealthAssessment.count({ where: { userId: offUser } }),
    ).toBe(0);
  });
});

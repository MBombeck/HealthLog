/**
 * Which text a check-in was answered in, end to end through the real routes
 * and the real schema, checked against the published contract by the kit.
 *
 * The client says only two things: the reader's language and whether they
 * switched to the English original. The server resolves the rest from the
 * wording registry and stores it on the row, and every read returns it:
 *   - a language with a validated translation records `validated`;
 *   - a language with HealthLog's own translation records
 *     `unvalidated_translation`;
 *   - the switch records `original_en`;
 *   - English records `validated` whatever the switch says.
 * The PHQ-9 crisis signpost answers item 9 the same way in every wording,
 * and the doctor report counts the totals answered in an unvalidated
 * translation per score type, so its renderers can mark them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  GET as listAssessments,
  POST as createAssessment,
} from "@/app/api/mental-health/assessments/route";
import { GET as readAssessment } from "@/app/api/mental-health/assessments/[id]/route";
import { collectDoctorReportData } from "@/lib/doctor-report-data";
import { selectionFromLeaves } from "@/lib/report-selection/selection";

import { callRoute } from "../kit/call-route";
import { makeSession, makeUser, type SessionFixture } from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

// The reminder satisfy and the rollup tail hand work to pg-boss; the queue is
// not what this file is about.
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({ send: vi.fn().mockResolvedValue("wording-job") }),
}));

interface Row {
  id: string;
  instrument: string;
  locale: string;
  wording: string | null;
  item9Flagged: boolean;
}
interface Created {
  assessment: Row;
  crisis: { emergencyNumber: string } | null;
}

const PHQ9_ITEM9 = [0, 0, 0, 0, 0, 0, 0, 0, 1];
const SCI = [2, 2, 2, 2, 2, 2, 2, 2];

let session: SessionFixture;

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  const user = await makeUser({
    locale: "nl",
    modulePreferencesJson: { mentalHealth: true },
  });
  session = await makeSession(user);
});

async function submit(body: Record<string, unknown>) {
  const result = await callRoute<Created>(createAssessment, {
    method: "POST",
    route: "/api/mental-health/assessments",
    body,
    auth: session,
  });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.data;
}

describe("the wording a check-in records", () => {
  it("records a validated translation, HealthLog's own translation and the English original apart", async () => {
    const validated = await submit({
      instrument: "PHQ9",
      items: PHQ9_ITEM9,
      locale: "nl",
    });
    const translation = await submit({
      instrument: "SCI",
      items: SCI,
      locale: "nl",
    });
    const original = await submit({
      instrument: "SCI",
      items: SCI,
      locale: "nl",
      englishOriginal: true,
    });
    const english = await submit({
      instrument: "SCI",
      items: SCI,
      locale: "en",
      englishOriginal: true,
    });

    expect(validated.assessment.wording).toBe("validated");
    expect(translation.assessment.wording).toBe("unvalidated_translation");
    expect(original.assessment.wording).toBe("original_en");
    expect(english.assessment.wording).toBe("validated");

    const stored = await getPrismaClient().mentalHealthAssessment.findMany({
      select: { id: true, locale: true, wording: true },
    });
    const byId = new Map(stored.map((row) => [row.id, row]));
    expect(byId.get(translation.assessment.id)).toMatchObject({
      locale: "nl",
      wording: "unvalidated_translation",
    });
    expect(byId.get(original.assessment.id)).toMatchObject({
      locale: "nl",
      wording: "original_en",
    });

    const list = await callRoute<{ assessments: Row[] }>(listAssessments, {
      method: "GET",
      route: "/api/mental-health/assessments",
      auth: session,
    });
    expect(list.status).toBe(200);
    expect(
      Object.fromEntries(list.data.assessments.map((r) => [r.id, r.wording])),
    ).toEqual({
      [validated.assessment.id]: "validated",
      [translation.assessment.id]: "unvalidated_translation",
      [original.assessment.id]: "original_en",
      [english.assessment.id]: "validated",
    });

    const detail = await callRoute<{ assessment: Row }>(readAssessment, {
      method: "GET",
      route: "/api/mental-health/assessments/{id}",
      params: { id: translation.assessment.id },
      auth: session,
    });
    expect(detail.status).toBe(200);
    expect(detail.data.assessment.wording).toBe("unvalidated_translation");
  });

  it("defaults to the account's language when the client sends none", async () => {
    const created = await submit({ instrument: "SCI", items: SCI });
    expect(created.assessment.locale).toBe("nl");
    expect(created.assessment.wording).toBe("unvalidated_translation");
  });

  it("answers PHQ-9 item 9 with the crisis signpost in every wording", async () => {
    for (const body of [
      { locale: "nl" },
      { locale: "ko" },
      { locale: "pt-BR" },
      { locale: "de" },
      { locale: "nl", englishOriginal: true },
      { locale: "en" },
    ]) {
      const created = await submit({
        instrument: "PHQ9",
        items: PHQ9_ITEM9,
        ...body,
      });
      expect(created.assessment.item9Flagged, JSON.stringify(body)).toBe(true);
      expect(created.crisis, JSON.stringify(body)).not.toBeNull();
    }
    const quiet = await submit({
      instrument: "PHQ9",
      items: [3, 3, 3, 3, 3, 3, 3, 3, 0],
      locale: "pt-BR",
    });
    expect(quiet.crisis).toBeNull();
  });

  it("refuses a switch that is not a boolean", async () => {
    const result = await callRoute(createAssessment, {
      method: "POST",
      route: "/api/mental-health/assessments",
      body: { instrument: "SCI", items: SCI, englishOriginal: "yes" },
      auth: session,
    });
    expect(result.status).toBe(422);
    expect(await getPrismaClient().mentalHealthAssessment.count()).toBe(0);
  });
});

describe("the doctor report", () => {
  it("counts the screener totals answered in an unvalidated translation, per score type", async () => {
    await submit({ instrument: "SCI", items: SCI, locale: "nl" });
    await submit({ instrument: "SCI", items: SCI, locale: "nl" });
    await submit({
      instrument: "SCI",
      items: SCI,
      locale: "nl",
      englishOriginal: true,
    });
    await submit({ instrument: "PHQ9", items: PHQ9_ITEM9, locale: "nl" });

    const now = Date.now();
    const range = {
      start: new Date(now - 7 * 86_400_000),
      end: new Date(now + 60_000),
      days: 8,
    };
    const report = await collectDoctorReportData(
      session.userId,
      range,
      selectionFromLeaves(["SCI_SCORE", "PHQ9_SCORE"]),
    );
    expect(report.stats.SCI_SCORE?.count).toBe(3);
    expect(report.screenerUnvalidatedTranslations).toEqual({ SCI_SCORE: 2 });

    // Without the screener leaves the table is not asked at all.
    const withoutScreeners = await collectDoctorReportData(
      session.userId,
      range,
      selectionFromLeaves(["WEIGHT"]),
    );
    expect(withoutScreeners.screenerUnvalidatedTranslations).toBeNull();
  });
});

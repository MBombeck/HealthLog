/**
 * v1.43 (#614) — the life circumstances through the real routes against real
 * Postgres: every new fact kind written, corrected and removed and read back
 * through `GET /api/anamnesis/life-circumstances`; the closed legacy lists
 * (`GET /api/anamnesis/facts`, `GET /api/mental-health/assessments`) never
 * showing a new kind or AUDIT-C; the AUDIT-C cut-off from the entry's
 * language and the profile's sex; the AI switches leaving the about-me wire
 * at its eight values; and the sealed values never sitting in the clear.
 */
import { Buffer } from "node:buffer";

import { beforeEach, describe, expect, it, vi } from "vitest";

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
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

type Handler = (request: Request, ctx?: unknown) => Promise<Response>;

let counter = 0;

async function makeUser(overrides: Record<string, unknown> = {}) {
  const suffix = `${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `life-${suffix}`,
      email: `life-${suffix}@example.test`,
      role: "USER",
      timezone: "UTC",
      locale: "en",
      onboardingCompletedAt: new Date(),
      modulePreferencesJson: { mentalHealth: true },
      ...overrides,
    },
  });
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

function request(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function data<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return (JSON.parse(text) as { data: T }).data;
}

async function postFact(body: unknown): Promise<Response> {
  const { POST } = await import("@/app/api/anamnesis/facts/route");
  return (POST as unknown as Handler)(
    request("POST", "/api/anamnesis/facts", body),
  );
}

async function patchFact(id: string, body: unknown): Promise<Response> {
  const { PATCH } = await import("@/app/api/anamnesis/facts/[id]/route");
  return (PATCH as unknown as Handler)(
    request("PATCH", `/api/anamnesis/facts/${id}`, body),
    { params: Promise.resolve({ id }) },
  );
}

async function deleteFact(id: string): Promise<Response> {
  const { DELETE } = await import("@/app/api/anamnesis/facts/[id]/route");
  return (DELETE as unknown as Handler)(
    request("DELETE", `/api/anamnesis/facts/${id}`),
    { params: Promise.resolve({ id }) },
  );
}

interface Life {
  sections: Array<{
    key: string;
    aiIncluded: boolean;
    lastConfirmedAt: string | null;
    facts: Array<{ id: string; kind: string; value: unknown }>;
  }>;
  derived: {
    packYears: { value: number | null; status: string };
    activityMinutesPerWeek: {
      value: number | null;
      meetsWho150: boolean | null;
    };
    freeWeekdays: { days: number[]; source: string };
  };
  auditC: {
    latest: {
      id: string;
      totalScore: number;
      cutoff: { value: number; source: string } | null;
      aboveCutoff: boolean | null;
    } | null;
    history: Array<{ id: string }>;
    offerDue: boolean;
    instrument: { locale: string; validatedLocale: boolean };
  };
}

async function readLife(): Promise<Life> {
  const { GET } = await import("@/app/api/anamnesis/life-circumstances/route");
  return data<Life>(await (GET as unknown as () => Promise<Response>)());
}

function factOf(life: Life, kind: string) {
  return life.sections.flatMap((s) => s.facts).find((f) => f.kind === kind);
}

const VALUES = {
  TOBACCO_DETAIL: {
    schema: 1,
    products: ["cigarettes"],
    cigarettesPerDay: 20,
    startYear: 1990,
    quitMonth: "2020-06",
    secondhandSmoke: false,
  },
  ACTIVITY_HABIT: {
    schema: 1,
    moderateDaysPerWeek: 3,
    moderateMinutesPerDay: 40,
    sittingHoursWorkday: 7.5,
  },
  WORK_CONTEXT: {
    schema: 1,
    situation: "outdoor",
    physicalNature: "heavy_physical",
    nightWork: null,
    exposures: ["heat", "dust"],
  },
  FREE_WEEKDAYS: { schema: 1, days: [2, 3] },
  HABITS: {
    schema: 1,
    napRegularly: true,
    snoringReported: null,
    dietPattern: "vegetarian",
    dietSpecifics: ["low_carb"],
    lateMealsPerWeek: 2,
    fruitVegPortionsPerDay: 4,
    caffeineDrinksPerDay: 3,
    latestCaffeine: "15_18",
  },
  HEALTH_GOALS: { schema: 1, goals: ["sleep", "fitness"] },
} as const;

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  counter = 0;
});

describe("life-circumstance facts", () => {
  it("writes, corrects and removes every new kind, and the closed list never shows one", async () => {
    const user = await makeUser();
    await signIn(user.id);

    await data(
      await postFact({ kind: "SMOKING_STATUS", value: "FORMER" }),
      201,
    );
    for (const [kind, value] of Object.entries(VALUES)) {
      await data(await postFact({ kind, value }), 201);
    }

    let life = await readLife();
    for (const [kind, value] of Object.entries(VALUES)) {
      expect(factOf(life, kind)?.value, kind).toEqual(value);
    }
    expect(life.sections.map((s) => s.key)).toEqual([
      "tobacco",
      "alcohol",
      "activity",
      "work",
      "habits",
      "goals",
    ]);
    expect(life.derived.packYears).toEqual({ value: 30, status: "computed" });
    expect(life.derived.activityMinutesPerWeek).toMatchObject({
      value: 120,
      meetsWho150: false,
    });
    expect(life.derived.freeWeekdays).toEqual({ days: [2, 3], source: "fact" });

    // A second current answer of the same kind is the existing 409.
    expect(
      (await postFact({ kind: "HABITS", value: VALUES.HABITS })).status,
    ).toBe(409);

    // Correct: a dated successor with the new value.
    const goals = factOf(life, "HEALTH_GOALS")!;
    const corrected = await data<{ id: string; value: unknown }>(
      await patchFact(goals.id, {
        value: { schema: 1, goals: ["quit_smoking"] },
        validFrom: "2026-01-01",
      }),
    );
    expect(corrected.value).toEqual({ schema: 1, goals: ["quit_smoking"] });
    // A string for an object kind is the existing 422.
    expect((await patchFact(corrected.id, { value: "SLEEP" })).status).toBe(
      422,
    );

    // Remove: the interval closes; the kind reads as not recorded.
    const habits = factOf(life, "HABITS")!;
    await data(await deleteFact(habits.id));
    life = await readLife();
    expect(factOf(life, "HABITS")).toBeUndefined();
    expect(factOf(life, "HEALTH_GOALS")?.value).toEqual({
      schema: 1,
      goals: ["quit_smoking"],
    });

    // The closed list: three kinds, nothing else, in `current` and `history`.
    const { GET } = await import("@/app/api/anamnesis/facts/route");
    const legacy = await data<{
      current: Record<string, unknown>;
      history: Array<{ kind: string }>;
    }>(await (GET as unknown as () => Promise<Response>)());
    expect(Object.keys(legacy.current).sort()).toEqual([
      "ALCOHOL_PATTERN",
      "SHIFT_SCHEDULE",
      "SMOKING_STATUS",
    ]);
    expect(
      legacy.history.every((row) =>
        ["SMOKING_STATUS", "ALCOHOL_PATTERN", "SHIFT_SCHEDULE"].includes(
          row.kind,
        ),
      ),
    ).toBe(true);
    expect(legacy.history).toHaveLength(1);
  });

  it("seals the values: no answer sits in the clear", async () => {
    const user = await makeUser();
    await signIn(user.id);
    await data(
      await postFact({ kind: "WORK_CONTEXT", value: VALUES.WORK_CONTEXT }),
      201,
    );
    const row =
      await getPrismaClient().healthProfileFactRevision.findFirstOrThrow({
        where: { userId: user.id, kind: "WORK_CONTEXT" },
      });
    const raw = Buffer.from(row.valueEncrypted).toString("latin1");
    expect(raw).not.toContain("outdoor");
    expect(raw).not.toContain("heavy_physical");
  });

  it("dates an answer back to the month given", async () => {
    const user = await makeUser();
    await signIn(user.id);
    const created = await data<{ validFrom: string }>(
      await postFact({
        kind: "FREE_WEEKDAYS",
        value: VALUES.FREE_WEEKDAYS,
        validFrom: "2025-04-01",
      }),
      201,
    );
    expect(created.validFrom).toBe("2025-04-01T12:00:00.000Z");
  });
});

describe("free weekdays in a prompt", () => {
  it("are read for a prompt only while the work section is released", async () => {
    const user = await makeUser();
    await signIn(user.id);
    await data(
      await postFact({ kind: "FREE_WEEKDAYS", value: VALUES.FREE_WEEKDAYS }),
      201,
    );
    const { loadFreeWeekdaySpans, loadFreeWeekdaySpansForPrompt } =
      await import("@/lib/profile/life-circumstances");

    await getPrismaClient().userHealthProfile.upsert({
      where: { userId: user.id },
      create: { userId: user.id, aiIncludedSections: ["WORK"] },
      update: { aiIncludedSections: ["WORK"] },
    });
    expect(await loadFreeWeekdaySpansForPrompt(user.id)).toHaveLength(1);

    await getPrismaClient().userHealthProfile.update({
      where: { userId: user.id },
      data: { aiIncludedSections: ["ABOUT_ME"] },
    });
    expect(await loadFreeWeekdaySpansForPrompt(user.id)).toEqual([]);
    // The data surfaces still show the person their own answer.
    expect(await loadFreeWeekdaySpans(user.id)).toHaveLength(1);
  });
});

describe("AUDIT-C", () => {
  async function postAuditC(body: unknown): Promise<Response> {
    const { POST } = await import("@/app/api/anamnesis/audit-c/route");
    return (POST as unknown as Handler)(
      request("POST", "/api/anamnesis/audit-c", body),
    );
  }

  it("scores a German entry of a woman with sum 4 at the S3 cut-off, and none without a sex", async () => {
    const woman = await makeUser({ locale: "de", gender: "FEMALE" });
    await signIn(woman.id);
    const { result } = await data<{
      result: {
        totalScore: number;
        aboveCutoff: boolean | null;
        cutoff: { value: number; source: string; sourceLabel: string } | null;
        validatedLocale: boolean;
      };
    }>(
      await postAuditC({ items: [2, 1, 1], locale: "de", source: "WEB" }),
      201,
    );
    expect(result.totalScore).toBe(4);
    expect(result.aboveCutoff).toBe(true);
    expect(result.cutoff).toMatchObject({ value: 4, source: "S3_ALCOHOL_DE" });
    expect(result.validatedLocale).toBe(true);

    const nobody = await makeUser({ locale: "de", gender: null });
    await signIn(nobody.id);
    const unsexed = await data<{
      result: { cutoff: unknown; aboveCutoff: unknown };
    }>(
      await postAuditC({ items: [2, 1, 1], locale: "de", source: "WEB" }),
      201,
    );
    expect(unsexed.result.cutoff).toBeNull();
    expect(unsexed.result.aboveCutoff).toBeNull();
  });

  it("replays one externalId to the same entry and never lists it among the screeners", async () => {
    const user = await makeUser({ locale: "fr", gender: "MALE" });
    await signIn(user.id);
    const body = {
      items: [1, 0, 0],
      source: "IOS",
      externalId: "outbox-audit-1",
    };
    const first = await data<{ result: { id: string } }>(
      await postAuditC(body),
      201,
    );
    const again = await data<{ result: { id: string } }>(
      await postAuditC(body),
      200,
    );
    expect(again.result.id).toBe(first.result.id);

    // A screener with the same client id is its own record, not this one.
    const { POST: postScreener, GET: listScreeners } =
      await import("@/app/api/mental-health/assessments/route");
    const screener = await (postScreener as unknown as Handler)(
      request("POST", "/api/mental-health/assessments", {
        instrument: "WHO5",
        items: [3, 3, 3, 3, 3],
        source: "IOS",
        externalId: "outbox-audit-1",
      }),
    );
    expect(screener.status).toBe(201);

    const { NextRequest } = await import("next/server");
    const list = await data<{ assessments: Array<{ instrument: string }> }>(
      await (listScreeners as unknown as (r: Request) => Promise<Response>)(
        new NextRequest("http://localhost/api/mental-health/assessments"),
      ),
    );
    expect(list.assessments.map((a) => a.instrument)).toEqual(["WHO5"]);

    // The detail route answers 404 for an AUDIT-C id.
    const { GET: detail } =
      await import("@/app/api/mental-health/assessments/[id]/route");
    const byId = await (detail as unknown as Handler)(
      new NextRequest(
        `http://localhost/api/mental-health/assessments/${first.result.id}`,
      ),
      { params: Promise.resolve({ id: first.result.id }) },
    );
    expect(byId.status).toBe(404);

    // The read route carries it, with the English items for French.
    const life = await readLife();
    expect(life.auditC.latest?.id).toBe(first.result.id);
    expect(life.auditC.offerDue).toBe(false);
    expect(life.auditC.instrument).toMatchObject({
      locale: "en",
      validatedLocale: false,
    });
  });

  it("scores against the wording offered and refuses another one or a future date", async () => {
    // An English account is shown the English wording; a German cut-off for
    // it would be the stricter S3 table applied to questions never asked.
    const man = await makeUser({ locale: "en", gender: "MALE" });
    await signIn(man.id);
    const wrong = await postAuditC({
      items: [2, 1, 1],
      locale: "de",
      source: "IOS",
    });
    expect(wrong.status).toBe(422);
    const { result } = await data<{
      result: { locale: string; cutoff: { source: string } | null };
    }>(await postAuditC({ items: [2, 1, 1], source: "IOS" }), 201);
    expect(result.locale).toBe("en");
    expect(result.cutoff?.source).toBe("BRADLEY_2007");

    // French has no validated wording, so the English one is offered and
    // stored, whatever the account language says.
    const french = await makeUser({ locale: "fr", gender: "MALE" });
    await signIn(french.id);
    const fr = await data<{ result: { locale: string } }>(
      await postAuditC({ items: [0, 0, 1], locale: "fr", source: "WEB" }),
      201,
    );
    expect(fr.result.locale).toBe("en");

    const future = await postAuditC({
      items: [0, 0, 0],
      source: "WEB",
      takenAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    expect(future.status).toBe(422);
    const skew = await postAuditC({
      items: [0, 0, 0],
      source: "WEB",
      takenAt: new Date(Date.now() + 60 * 1000).toISOString(),
    });
    expect(skew.status).toBe(201);
  });

  it("reads latest and the offer from the newest entry whose answers open", async () => {
    const user = await makeUser();
    await signIn(user.id);
    const older = await data<{ result: { id: string } }>(
      await postAuditC({
        items: [1, 0, 0],
        source: "WEB",
        takenAt: "2025-01-10T09:00:00.000Z",
      }),
      201,
    );
    // A newer entry this host cannot open (its key is gone).
    const sealed = await getPrismaClient().mentalHealthAssessment.create({
      data: {
        userId: user.id,
        instrument: "AUDIT_C",
        locale: "en",
        responsesEncrypted: new Uint8Array([9, 9, 9, 9]),
        totalScore: 11,
        severityBand: "unbanded",
        takenAt: new Date(),
        source: "WEB",
      },
    });
    const life = await readLife();
    expect(life.auditC.latest?.id).toBe(older.result.id);
    // Timed from the result shown, not from the entry nobody can read.
    expect(life.auditC.offerDue).toBe(true);
    // Still listed, so it can be removed.
    expect(life.auditC.history.map((h) => h.id)).toContain(sealed.id);
  });

  it("soft-deletes an entry once, and only an AUDIT-C entry of the record", async () => {
    const user = await makeUser();
    await signIn(user.id);
    const { result } = await data<{ result: { id: string } }>(
      await postAuditC({ items: [0, 0, 0], source: "WEB" }),
      201,
    );
    const { DELETE } = await import("@/app/api/anamnesis/audit-c/[id]/route");
    const remove = (id: string) =>
      (DELETE as unknown as Handler)(
        request("DELETE", `/api/anamnesis/audit-c/${id}`),
        { params: Promise.resolve({ id }) },
      );
    const removed = await data<{ id: string; removedAt: string }>(
      await remove(result.id),
    );
    expect(removed.id).toBe(result.id);
    const again = await remove(result.id);
    expect(again.status).toBe(404);
    expect(
      ((await again.json()) as { error: { code?: string }; meta?: unknown })
        .error,
    ).toBeTruthy();
    const row =
      await getPrismaClient().mentalHealthAssessment.findUniqueOrThrow({
        where: { id: result.id },
      });
    expect(row.deletedAt).not.toBeNull();
    expect((await readLife()).auditC.latest).toBeNull();
  });
});

describe("AI switches and confirmations", () => {
  it("switches a life section without showing it on the about-me wire, and a PUT there keeps it", async () => {
    const user = await makeUser({
      modulePreferencesJson: { mentalHealth: true, coach: true },
    });
    await signIn(user.id);
    const { PATCH } =
      await import("@/app/api/anamnesis/life-circumstances/ai-sections/route");
    const switched = await data<{ aiSections: Record<string, boolean> }>(
      await (PATCH as unknown as Handler)(
        request("PATCH", "/api/anamnesis/life-circumstances/ai-sections", {
          sections: { HABITS: true, SMOKING_STATUS: false },
        }),
      ),
    );
    expect(switched.aiSections).toMatchObject({
      HABITS: true,
      SMOKING_STATUS: false,
      ACTIVITY: false,
    });
    const life = await readLife();
    expect(life.sections.find((s) => s.key === "habits")?.aiIncluded).toBe(
      true,
    );
    expect(life.sections.find((s) => s.key === "tobacco")?.aiIncluded).toBe(
      false,
    );

    const aboutMe = await import("@/app/api/coach/about-me/route");
    const read = await data<{ aiIncludedSections: string[] }>(
      await (aboutMe.GET as unknown as () => Promise<Response>)(),
    );
    expect(read.aiIncludedSections).not.toContain("HABITS");
    await data(
      await (aboutMe.PUT as unknown as Handler)(
        request("PUT", "/api/coach/about-me", {
          aiIncludedSections: ["ABOUT_ME"],
        }),
      ),
    );
    const stored = await getPrismaClient().userHealthProfile.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect([...stored.aiIncludedSections].sort()).toEqual([
      "ABOUT_ME",
      "HABITS",
    ]);
  });

  it("never turns a section on again that a concurrent switch turned off", async () => {
    const user = await makeUser({
      modulePreferencesJson: { mentalHealth: true, coach: true },
    });
    await signIn(user.id);
    const prisma = getPrismaClient();
    await prisma.userHealthProfile.create({
      data: { userId: user.id, aiIncludedSections: ["ABOUT_ME", "HABITS"] },
    });
    const { lockAiSections } = await import("@/lib/profile/life-circumstances");
    const aboutMe = await import("@/app/api/coach/about-me/route");

    // The switch-off holds its transaction open while the PUT starts.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const switchOff = prisma.$transaction(async (tx) => {
      await lockAiSections(tx, user.id);
      await tx.userHealthProfile.update({
        where: { userId: user.id },
        data: { aiIncludedSections: ["ABOUT_ME"] },
      });
      locked();
      await held;
    });
    await isLocked;
    const put = (aboutMe.PUT as unknown as Handler)(
      request("PUT", "/api/coach/about-me", {
        aiIncludedSections: ["ABOUT_ME", "CONDITIONS"],
      }),
    );
    // Long enough for an unlocked PUT to have read the old array.
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await switchOff;
    await data(await put);

    const stored = await prisma.userHealthProfile.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect([...stored.aiIncludedSections].sort()).toEqual([
      "ABOUT_ME",
      "CONDITIONS",
    ]);
  });

  it("answers a stale token with about_me_conflict", async () => {
    const user = await makeUser();
    await signIn(user.id);
    await getPrismaClient().userHealthProfile.create({
      data: { userId: user.id },
    });
    const { PATCH } =
      await import("@/app/api/anamnesis/life-circumstances/ai-sections/route");
    const response = await (PATCH as unknown as Handler)(
      request("PATCH", "/api/anamnesis/life-circumstances/ai-sections", {
        sections: { WORK: true },
        baseUpdatedAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    expect(response.status).toBe(409);
    expect(
      ((await response.json()) as { error: { errorCode?: string } }).error,
    ).toBeTruthy();
  });

  it("stores a confirmation as a stamp, never as a revision", async () => {
    const user = await makeUser();
    await signIn(user.id);
    const { POST } =
      await import("@/app/api/anamnesis/life-circumstances/confirm/route");
    const confirmed = await data<{ section: string; lastConfirmedAt: string }>(
      await (POST as unknown as Handler)(
        request("POST", "/api/anamnesis/life-circumstances/confirm", {
          section: "work",
        }),
      ),
    );
    expect(confirmed.section).toBe("work");
    const life = await readLife();
    expect(life.sections.find((s) => s.key === "work")?.lastConfirmedAt).toBe(
      confirmed.lastConfirmedAt,
    );
    expect(
      await getPrismaClient().healthProfileFactRevision.count({
        where: { userId: user.id },
      }),
    ).toBe(0);
  });
});

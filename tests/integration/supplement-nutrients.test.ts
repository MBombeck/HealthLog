/**
 * v1.43 — supplement composition to micronutrients, against a real Postgres.
 *
 * Drives the shipped routes and the real recompute:
 *   - the catalogue answers behind the nutrients module, with DHA and EPA,
 *     input units and upper limits;
 *   - the PUT stores amounts canonically (vitamin D in IU), refuses an
 *     unknown code and a unit the code does not offer, and 404s a foreign
 *     medication;
 *   - the contract's acceptance case: 25 µg vitamin D per capsule, two
 *     capsules per dose, one dose taken and one skipped → 50 µg that day, all
 *     of it SUPPLEMENT; a third capsule pair crosses the upper limit;
 *   - marking the taken dose as not taken, correcting it and deleting it each
 *     remove the day's SUPPLEMENT row; a changed composition recomputes the
 *     history; an automatically recorded dose counts;
 *   - the recompute is idempotent, writes nothing with the module off, and a
 *     deleted medication takes its rows with it;
 *   - the label read is refused without a provider, under the operator's
 *     switch and with the module off, and is queued as a
 *     `SUPPLEMENT_LABEL_EXTRACT` run when every layer is open.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { encrypt } from "@/lib/crypto";
import { userDayKey } from "@/lib/tz/format";

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
vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: vi.fn(),
}));
// The label read hands its run to a queue; this one accepts the job so the
// 202 and the stored run can be read back. Nothing here runs the job, so no
// model is called. `getGlobalBoss` is otherwise null in this suite, which is
// what makes the composition recompute run inline.
const queuedRuns: unknown[] = [];
let bossAvailable = false;
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () =>
    bossAvailable
      ? {
          send: vi.fn(async (_queue: string, payload: unknown) => {
            queuedRuns.push(payload);
            return "job-1";
          }),
        }
      : null,
}));

const TZ = "Europe/Berlin";
let counter = 0;

type Handler = (
  request: NextRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: { params: Promise<any> },
) => Promise<Response>;

interface Envelope<T = unknown> {
  data: T;
  error: string | null;
  meta?: Record<string, unknown>;
}

async function makeUser(
  options: { nutrients?: boolean; overrides?: Record<string, unknown> } = {},
): Promise<string> {
  const suffix = `sup-${counter++}`;
  const user = await getPrismaClient().user.create({
    data: {
      username: suffix,
      email: `${suffix}@example.test`,
      timezone: TZ,
      locale: "en",
      onboardingCompletedAt: new Date(),
      modulePreferencesJson: { nutrients: options.nutrients ?? true },
      ...options.overrides,
    },
  });
  const session = await getPrismaClient().session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user.id;
}

async function call<T = unknown>(
  handler: Handler,
  method: string,
  path: string,
  body?: unknown,
  params: Record<string, string> = {},
): Promise<{ status: number; body: Envelope<T> }> {
  const res = await handler(
    new NextRequest(`http://localhost${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    }),
    { params: Promise.resolve(params) },
  );
  return { status: res.status, body: (await res.json()) as Envelope<T> };
}

/** A vitamin D supplement taken as needed, two capsules a dose. */
async function vitaminD(userId: string): Promise<string> {
  const medication = await getPrismaClient().medication.create({
    data: {
      userId,
      name: "Vitamin D3",
      dose: "2 capsules",
      unitsPerDose: 2,
      asNeeded: true,
    },
    select: { id: true },
  });
  return medication.id;
}

async function putIngredients(
  medicationId: string,
  body: unknown,
): Promise<{ status: number; body: Envelope }> {
  const { PUT } = await import("@/app/api/medications/[id]/ingredients/route");
  return call(
    PUT as Handler,
    "PUT",
    `/api/medications/${medicationId}/ingredients`,
    body,
    { id: medicationId },
  );
}

async function logDose(
  medicationId: string,
  at: Date,
  skipped = false,
): Promise<string> {
  const { POST } = await import("@/app/api/medications/[id]/intake/route");
  const { status, body } = await call<{ id: string }>(
    POST as Handler,
    "POST",
    `/api/medications/${medicationId}/intake`,
    skipped
      ? { skipped: true, scheduledFor: at.toISOString() }
      : { takenAt: at.toISOString() },
    { id: medicationId },
  );
  expect(status, JSON.stringify(body)).toBeLessThan(300);
  return body.data.id;
}

interface DailyBody {
  days: Array<{
    day: string;
    amount: number;
    bySource: Record<string, number>;
    aboveUpperLimit: boolean | null;
  }>;
  upperLimit: { value: number; scope: string } | null;
}

async function vitaminDOn(day: string) {
  const { GET } = await import("@/app/api/nutrients/daily/route");
  const { status, body } = await call<DailyBody>(
    GET as Handler,
    "GET",
    "/api/nutrients/daily?nutrient=vitamin_d&days=7",
  );
  expect(status).toBe(200);
  return {
    entry: body.data.days.find((d) => d.day === day)!,
    upperLimit: body.data.upperLimit,
  };
}

async function supplementRows(userId: string) {
  return getPrismaClient().nutrientIntakeDay.findMany({
    where: { userId, source: "SUPPLEMENT" },
    orderBy: [{ day: "asc" }, { nutrient: "asc" }],
    select: { day: true, nutrient: true, amount: true, unit: true },
  });
}

/** An instant this morning in Berlin, safely in the past. */
function earlierToday(hoursAgo = 1): Date {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  queuedRuns.length = 0;
  bossAvailable = false;
});

describe("GET /api/nutrients/catalog", () => {
  it("answers with every code, DHA and EPA unsyncable, input units and upper limits", async () => {
    await makeUser();
    const { GET } = await import("@/app/api/nutrients/catalog/route");
    const { status, body } = await call<{
      entries: Array<{
        code: string;
        unit: string;
        label: string;
        syncable: boolean;
        inputUnits: Array<{ unit: string; factorToCanonical: number }>;
        upperLimit: { value: number; scope: string; source: string } | null;
      }>;
    }>(GET as Handler, "GET", "/api/nutrients/catalog");
    expect(status).toBe(200);
    const byCode = new Map(body.data.entries.map((e) => [e.code, e]));
    expect(byCode.get("dha")).toMatchObject({
      unit: "mg",
      syncable: false,
      label: "DHA (omega-3)",
      upperLimit: null,
    });
    expect(byCode.get("epa")?.syncable).toBe(false);
    expect(byCode.get("vitamin_d")?.inputUnits).toContainEqual({
      unit: "IU",
      factorToCanonical: 0.025,
    });
    expect(byCode.get("vitamin_d")?.upperLimit).toMatchObject({
      value: 100,
      scope: "total",
    });
    expect(byCode.get("magnesium")?.upperLimit?.scope).toBe("supplemental");
  });

  it("is behind the nutrients module", async () => {
    await makeUser({ nutrients: false });
    const { GET } = await import("@/app/api/nutrients/catalog/route");
    const { status, body } = await call(
      GET as Handler,
      "GET",
      "/api/nutrients/catalog",
    );
    expect(status).toBe(403);
    expect(body.meta?.errorCode).toBe("module.disabled");
  });
});

describe("PUT /api/medications/{id}/ingredients", () => {
  it("stores vitamin D entered in IU canonically and keeps what was entered", async () => {
    const userId = await makeUser();
    const medicationId = await vitaminD(userId);
    const { status, body } = await putIngredients(medicationId, {
      ingredients: [
        { nutrient: "vitamin_d", amount: 1000, unit: "IU" },
        { nutrient: "magnesium", amount: 0.1, unit: "g" },
      ],
    });
    expect(status).toBe(200);
    expect(body.data).toMatchObject({
      ingredients: [
        {
          nutrient: "vitamin_d",
          amountPerUnit: 25,
          unit: "ug",
          enteredAmount: 1000,
          enteredUnit: "IU",
          label: "Vitamin D",
        },
        {
          nutrient: "magnesium",
          amountPerUnit: 100,
          unit: "mg",
          enteredAmount: 0.1,
          enteredUnit: "g",
        },
      ],
      recompute: { queued: false },
    });
    const stored = await getPrismaClient().medicationIngredient.findMany({
      where: { medicationId },
      orderBy: { nutrient: "asc" },
    });
    expect(
      stored.map((s) => [s.nutrient, s.amountPerUnit, s.unit, s.source]),
    ).toEqual([
      ["magnesium", 100, "mg", "MANUAL"],
      ["vitamin_d", 25, "ug", "MANUAL"],
    ]);

    // The detail read carries it, and the list says it has one.
    const detail = await import("@/app/api/medications/[id]/route");
    const read = await call<{ ingredients: Array<{ nutrient: string }> }>(
      detail.GET as Handler,
      "GET",
      `/api/medications/${medicationId}`,
      undefined,
      { id: medicationId },
    );
    expect(read.body.data.ingredients.map((i) => i.nutrient)).toEqual([
      "vitamin_d",
      "magnesium",
    ]);
  });

  it("refuses a unit the code does not offer, naming the row and the units", async () => {
    const userId = await makeUser();
    const medicationId = await vitaminD(userId);
    const { status, body } = await putIngredients(medicationId, {
      ingredients: [
        { nutrient: "vitamin_d", amount: 25, unit: "ug" },
        { nutrient: "vitamin_e", amount: 400, unit: "IU" },
      ],
    });
    expect(status).toBe(422);
    expect(body.meta).toMatchObject({
      errorCode: "medications.ingredients.unitMismatch",
      index: 1,
      allowedUnits: ["mg", "ug", "g"],
    });
    expect(
      await getPrismaClient().medicationIngredient.count({
        where: { medicationId },
      }),
    ).toBe(0);
  });

  it("refuses an unknown code and a duplicate code", async () => {
    const userId = await makeUser();
    const medicationId = await vitaminD(userId);
    const unknown = await putIngredients(medicationId, {
      ingredients: [{ nutrient: "coenzyme_q10", amount: 30, unit: "mg" }],
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body.meta?.errorCode).toBe(
      "medications.ingredients.invalid",
    );
    const duplicate = await putIngredients(medicationId, {
      ingredients: [
        { nutrient: "zinc", amount: 10, unit: "mg" },
        { nutrient: "zinc", amount: 5, unit: "mg" },
      ],
    });
    expect(duplicate.status).toBe(422);
  });

  it("answers 404 for a medication of another account", async () => {
    const other = await makeUser();
    const foreign = await vitaminD(other);
    await makeUser();
    const { status, body } = await putIngredients(foreign, {
      ingredients: [{ nutrient: "zinc", amount: 10, unit: "mg" }],
    });
    expect(status).toBe(404);
    expect(body.meta?.errorCode).toBe("medications.notFound");
  });

  it("is behind the nutrients module", async () => {
    const userId = await makeUser({ nutrients: false });
    const medicationId = await vitaminD(userId);
    const { status, body } = await putIngredients(medicationId, {
      ingredients: [{ nutrient: "zinc", amount: 10, unit: "mg" }],
    });
    expect(status).toBe(403);
    expect(body.meta).toMatchObject({
      errorCode: "module.disabled",
      module: "nutrients",
    });
  });
});

describe("taken doses become the day's SUPPLEMENT micronutrients", () => {
  async function setUp() {
    const userId = await makeUser();
    const medicationId = await vitaminD(userId);
    expect(
      (
        await putIngredients(medicationId, {
          ingredients: [{ nutrient: "vitamin_d", amount: 25, unit: "ug" }],
        })
      ).status,
    ).toBe(200);
    return { userId, medicationId };
  }

  it("counts one taken dose of two capsules as 50 µg and the skipped one as nothing", async () => {
    const { medicationId } = await setUp();
    const takenAt = earlierToday(2);
    const day = userDayKey(takenAt, TZ);
    await logDose(medicationId, takenAt);
    await logDose(medicationId, earlierToday(1), true);

    const { entry, upperLimit } = await vitaminDOn(day);
    expect(entry.amount).toBe(50);
    expect(entry.bySource).toEqual({ SUPPLEMENT: 50 });
    expect(entry.aboveUpperLimit).toBe(false);
    expect(upperLimit).toMatchObject({ value: 100, scope: "total" });
  });

  it("notes a day above the upper limit once the doses pass it", async () => {
    const { medicationId } = await setUp();
    // 60 µg a capsule, two a dose: 120 µg against a total limit of 100.
    await putIngredients(medicationId, {
      ingredients: [{ nutrient: "vitamin_d", amount: 60, unit: "ug" }],
    });
    const takenAt = earlierToday(2);
    await logDose(medicationId, takenAt);
    const { entry } = await vitaminDOn(userDayKey(takenAt, TZ));
    expect(entry.amount).toBe(120);
    expect(entry.aboveUpperLimit).toBe(true);
  });

  it("removes the row when the taken dose is marked as not taken", async () => {
    const { userId, medicationId } = await setUp();
    const intakeId = await logDose(medicationId, earlierToday(2));
    expect(await supplementRows(userId)).toHaveLength(1);

    const { POST } = await import("@/app/api/medications/intake/route");
    const undo = await call(
      POST as Handler,
      "POST",
      "/api/medications/intake",
      { intakeId, status: "skipped" },
    );
    expect(undo.status).toBe(200);
    expect(await supplementRows(userId)).toEqual([]);
  });

  it("follows a correction and a delete of the dose", async () => {
    const { userId, medicationId } = await setUp();
    const intakeId = await logDose(medicationId, earlierToday(2));
    const route =
      await import("@/app/api/medications/[id]/intake/[eventId]/route");
    const corrected = await call(
      route.PUT as Handler,
      "PUT",
      `/api/medications/${medicationId}/intake/${intakeId}`,
      { skipped: true },
      { id: medicationId, eventId: intakeId },
    );
    expect(corrected.status).toBe(200);
    expect(await supplementRows(userId)).toEqual([]);

    const second = await logDose(medicationId, earlierToday(1));
    expect((await supplementRows(userId)).map((r) => r.amount)).toEqual([50]);
    const deleted = await call(
      route.DELETE as Handler,
      "DELETE",
      `/api/medications/${medicationId}/intake/${second}`,
      undefined,
      { id: medicationId, eventId: second },
    );
    expect(deleted.status).toBe(200);
    expect(await supplementRows(userId)).toEqual([]);
  });

  it("recomputes the history when the composition changes", async () => {
    const { userId, medicationId } = await setUp();
    // One dose through the route today, and one recorded two days ago
    // straight into the table (an imported history the PUT has to re-read).
    await logDose(medicationId, earlierToday(1));
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    await getPrismaClient().medicationIntakeEvent.create({
      data: {
        userId,
        medicationId,
        scheduledFor: twoDaysAgo,
        takenAt: twoDaysAgo,
      },
    });
    const { refreshDoseSlot } =
      await import("@/lib/medications/dose-day-refresh");
    await refreshDoseSlot({
      userId,
      medicationId,
      scheduledFor: twoDaysAgo,
      tz: TZ,
    });
    expect((await supplementRows(userId)).map((r) => r.amount)).toEqual([
      50, 50,
    ]);

    await putIngredients(medicationId, {
      ingredients: [
        { nutrient: "vitamin_d", amount: 50, unit: "ug" },
        { nutrient: "dha", amount: 250, unit: "mg" },
      ],
    });
    const rows = await supplementRows(userId);
    expect(
      rows.filter((r) => r.nutrient === "vitamin_d").map((r) => r.amount),
    ).toEqual([100, 100]);
    expect(
      rows.filter((r) => r.nutrient === "dha").map((r) => r.amount),
    ).toEqual([500, 500]);

    // An emptied composition leaves nothing behind.
    await putIngredients(medicationId, { ingredients: [] });
    expect(await supplementRows(userId)).toEqual([]);
  });

  it("is idempotent: a second pass writes the same rows", async () => {
    const { userId, medicationId } = await setUp();
    await logDose(medicationId, earlierToday(2));
    const { recomputeSupplementNutrientsForUser } =
      await import("@/lib/medications/ingredients/recompute");
    const before = await supplementRows(userId);
    await recomputeSupplementNutrientsForUser(userId);
    await recomputeSupplementNutrientsForUser(userId);
    expect(await supplementRows(userId)).toEqual(before);
  });

  it("takes the rows away with a deleted medication", async () => {
    const { userId, medicationId } = await setUp();
    await logDose(medicationId, earlierToday(2));
    const route = await import("@/app/api/medications/[id]/route");
    const res = await call(
      route.DELETE as Handler,
      "DELETE",
      `/api/medications/${medicationId}`,
      undefined,
      { id: medicationId },
    );
    expect(res.status).toBe(200);
    expect(await supplementRows(userId)).toEqual([]);
  });

  it("writes nothing while the nutrients module is off", async () => {
    const { userId, medicationId } = await setUp();
    await getPrismaClient().user.update({
      where: { id: userId },
      data: { modulePreferencesJson: { nutrients: false } },
    });
    await logDose(medicationId, earlierToday(2));
    expect(await supplementRows(userId)).toEqual([]);
  });

  it("counts a dose recorded automatically", async () => {
    const userId = await makeUser();
    const prisma = getPrismaClient();
    const medication = await prisma.medication.create({
      data: {
        userId,
        name: "Omega-3",
        dose: "1 capsule",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        autoMarkTaken: true,
        autoMarkTakenSince: new Date("2026-06-01T00:00:00.000Z"),
        schedules: {
          create: {
            windowStart: "19:00",
            windowEnd: "19:00",
            timesOfDay: ["19:00"],
            rrule: "FREQ=DAILY",
            scheduleType: "SCHEDULED",
          },
        },
      },
      select: { id: true },
    });
    await prisma.medicationIngredient.create({
      data: {
        userId,
        medicationId: medication.id,
        nutrient: "epa",
        amountPerUnit: 180,
        unit: "mg",
        source: "MANUAL",
      },
    });
    const { runIntakeAutoTakePass } =
      await import("@/lib/jobs/intake-auto-take");
    const result = await runIntakeAutoTakePass(prisma, {
      nowMs: Date.parse("2026-06-03T17:30:00.000Z"),
    });
    expect(result.recordedCount).toBeGreaterThan(0);
    const rows = await supplementRows(userId);
    expect(rows.length).toBe(result.recordedCount);
    expect(rows.every((r) => r.nutrient === "epa" && r.amount === 180)).toBe(
      true,
    );
  });
});

describe("POST /api/medications/{id}/ingredients/extract", () => {
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABXvMqOgAAAABJRU5ErkJggg==",
    "base64",
  );

  async function extract(medicationId: string, bytes: Buffer = PNG) {
    const { POST } =
      await import("@/app/api/medications/[id]/ingredients/extract/route");
    const form = new FormData();
    form.append(
      "file",
      new File([new Uint8Array(bytes)], "label.png", { type: "image/png" }),
    );
    const res = await (POST as Handler)(
      new NextRequest(
        `http://localhost/api/medications/${medicationId}/ingredients/extract`,
        { method: "POST", body: form },
      ),
      { params: Promise.resolve({ id: medicationId }) },
    );
    return { status: res.status, body: (await res.json()) as Envelope };
  }

  /** A person on their own Anthropic key, with the document consent. */
  async function readyUser(options: { nutrients?: boolean } = {}) {
    const userId = await makeUser({
      ...options,
      overrides: {
        aiProvider: "ANTHROPIC",
        aiModel: "claude-sonnet-4-6",
        aiAnthropicKeyEncrypted: encrypt("sk-ant-integration-test"),
      },
    });
    await getPrismaClient().consentReceipt.create({
      data: {
        userId,
        kind: "ai_extraction",
        artefact: "test",
        signedAt: new Date(),
      },
    });
    return userId;
  }

  it("queues a SUPPLEMENT_LABEL_EXTRACT run when every layer is open", async () => {
    bossAvailable = true;
    const userId = await readyUser();
    const medicationId = await vitaminD(userId);
    const { status, body } = await extract(medicationId);
    expect(status, JSON.stringify(body)).toBe(202);
    const runs = await getPrismaClient().documentAiRun.findMany({
      where: { userId },
    });
    expect(runs.map((r) => r.kind)).toEqual(["SUPPLEMENT_LABEL_EXTRACT"]);
    expect(queuedRuns).toHaveLength(1);
  });

  it("refuses without a provider and queues nothing", async () => {
    bossAvailable = true;
    const userId = await makeUser();
    const medicationId = await vitaminD(userId);
    const { status, body } = await extract(medicationId);
    expect(status).toBe(422);
    expect(body.meta).toMatchObject({
      capability: "supplementLabel",
      reason: "no_provider",
    });
    expect(await getPrismaClient().documentAiRun.count()).toBe(0);
  });

  it("refuses under the operator's switch and queues nothing", async () => {
    bossAvailable = true;
    const userId = await readyUser();
    await getPrismaClient().appSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", assistantDocumentAiEnabled: false },
      update: { assistantDocumentAiEnabled: false },
    });
    const medicationId = await vitaminD(userId);
    const { status, body } = await extract(medicationId);
    expect(status).toBe(403);
    expect(body.meta).toMatchObject({
      errorCode: "assistant.disabled.documentAi",
      capability: "supplementLabel",
      reason: "operator_disabled",
    });
    expect(await getPrismaClient().documentAiRun.count()).toBe(0);
  });

  it("refuses with the nutrients module off", async () => {
    const userId = await readyUser({ nutrients: false });
    const medicationId = await vitaminD(userId);
    const { status, body } = await extract(medicationId);
    expect(status).toBe(403);
    expect(body.meta?.errorCode).toBe("module.disabled");
  });

  it("refuses a file that is not an image or a PDF", async () => {
    bossAvailable = true;
    const userId = await readyUser();
    const medicationId = await vitaminD(userId);
    const { status, body } = await extract(
      medicationId,
      Buffer.from("plain text, not a label"),
    );
    expect(status).toBe(422);
    expect(body.meta?.errorCode).toBe(
      "medications.ingredients.extract.fileType",
    );
    expect(await getPrismaClient().documentAiRun.count()).toBe(0);
  });
});

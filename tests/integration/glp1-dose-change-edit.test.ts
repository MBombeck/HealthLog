/**
 * #169 — GLP-1 titration steps can be corrected and removed, a step two
 * devices hold is created once, and an injection site can be set on a dose
 * that was already recorded.
 *
 * Driven as routes against a real Postgres: the shipped handlers, the real
 * `apiHandler`, `requireRecordAuth`, rate limit and Prisma writes.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readNote } from "@/lib/crypto/note-cipher";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-glp1-dose-change-edit-integration-1234567890abcdef";
process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const USER_ID = "user-glp1-dose-change-edit";
const OTHER_ID = "user-glp1-dose-change-other";

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

/** A route whose params shape is its own business. */
type Handler = (
  request: NextRequest,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: { params: Promise<any> },
) => Promise<Response>;

const prisma = getPrismaClient();

/** Audit details as the row stores them (a JSON string). */
function details(raw: unknown): unknown {
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

beforeEach(async () => {
  await truncateAllTables(prisma);
  cookieJar.clear();
  headerJar.clear();
  for (const id of [USER_ID, OTHER_ID]) {
    await prisma.user.create({
      data: { id, username: id, email: `${id}@example.test`, timezone: "UTC" },
    });
  }
  const session = await prisma.session.create({
    data: { userId: USER_ID, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  cookieJar.set("healthlog_session", session.id);
});

function request(method: string, path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function seedMedication(userId = USER_ID): Promise<string> {
  const medication = await prisma.medication.create({
    data: {
      userId,
      name: "Semaglutide",
      dose: "0.25 mg",
      treatmentClass: "GLP1",
      deliveryForm: "INJECTION",
      trackInjectionSites: true,
      allowedInjectionSites: ["ABDOMEN_LEFT", "ABDOMEN_RIGHT"],
    },
  });
  return medication.id;
}

async function glp1() {
  return import("@/app/api/medications/[id]/glp1/route");
}
async function doseChangeRoute() {
  return import("@/app/api/medications/[id]/glp1/dose-changes/[doseChangeId]/route");
}

async function postStep(
  medicationId: string,
  doseChange: Record<string, unknown>,
): Promise<Response> {
  const { POST } = await glp1();
  return (POST as Handler)(
    request("POST", `/api/medications/${medicationId}/glp1`, { doseChange }),
    { params: Promise.resolve({ id: medicationId }) },
  );
}

const STEP = {
  effectiveFrom: "2026-09-01T08:00:00.000Z",
  doseValue: 0.5,
  doseUnit: "mg",
  note: "first step up",
};

describe("POST /api/medications/[id]/glp1 — clientId", () => {
  it("creates a step once per client id, and answers the stored row after", async () => {
    const medicationId = await seedMedication();
    const first = await postStep(medicationId, { ...STEP, clientId: "step-a" });
    expect(first.status).toBe(201);
    const created = (await first.json()).data.doseChange;
    expect(created.clientId).toBe("step-a");

    // The iPad uploads the same local step, under its own idempotency key.
    const second = await postStep(medicationId, {
      ...STEP,
      doseValue: 0.75,
      clientId: "step-a",
    });
    expect(second.status).toBe(200);
    const existing = (await second.json()).data.doseChange;
    expect(existing.id).toBe(created.id);
    expect(existing.doseValue).toBe(0.5);

    expect(
      await prisma.medicationDoseChange.count({ where: { medicationId } }),
    ).toBe(1);
  });

  it("keeps creating steps without a client id, and per medication with one", async () => {
    const a = await seedMedication();
    const b = await seedMedication();
    expect((await postStep(a, STEP)).status).toBe(201);
    expect((await postStep(a, STEP)).status).toBe(201);
    expect((await postStep(a, { ...STEP, clientId: "x" })).status).toBe(201);
    expect((await postStep(b, { ...STEP, clientId: "x" })).status).toBe(201);
    expect(await prisma.medicationDoseChange.count()).toBe(4);
  });

  it("lists the client id with every step", async () => {
    const medicationId = await seedMedication();
    await postStep(medicationId, { ...STEP, clientId: "step-a" });
    await postStep(medicationId, STEP);
    const { GET } = await glp1();
    const res = await (GET as Handler)(
      request("GET", `/api/medications/${medicationId}/glp1`),
      { params: Promise.resolve({ id: medicationId }) },
    );
    const steps = (await res.json()).data.doseChanges;
    expect(steps.map((s: { clientId: string | null }) => s.clientId)).toEqual(
      expect.arrayContaining(["step-a", null]),
    );
  });

  it("refuses a malformed client id", async () => {
    const medicationId = await seedMedication();
    for (const clientId of ["", "a b", "x".repeat(129)]) {
      expect((await postStep(medicationId, { ...STEP, clientId })).status).toBe(
        422,
      );
    }
  });
});

describe("PATCH and DELETE /api/medications/[id]/glp1/dose-changes/[doseChangeId]", () => {
  async function step(medicationId: string): Promise<string> {
    const res = await postStep(medicationId, { ...STEP, clientId: "step-a" });
    return (await res.json()).data.doseChange.id;
  }

  async function patch(
    medicationId: string,
    doseChangeId: string,
    body: unknown,
  ): Promise<Response> {
    const { PATCH } = await doseChangeRoute();
    return (PATCH as Handler)(
      request(
        "PATCH",
        `/api/medications/${medicationId}/glp1/dose-changes/${doseChangeId}`,
        body,
      ),
      { params: Promise.resolve({ id: medicationId, doseChangeId }) },
    );
  }

  async function remove(
    medicationId: string,
    doseChangeId: string,
  ): Promise<Response> {
    const { DELETE } = await doseChangeRoute();
    return (DELETE as Handler)(
      request(
        "DELETE",
        `/api/medications/${medicationId}/glp1/dose-changes/${doseChangeId}`,
      ),
      { params: Promise.resolve({ id: medicationId, doseChangeId }) },
    );
  }

  it("corrects the named fields, keeps the rest, and files what it overwrote", async () => {
    const medicationId = await seedMedication();
    const id = await step(medicationId);

    const res = await patch(medicationId, id, {
      doseValue: 1,
      effectiveFrom: "2026-09-08T08:00:00.000Z",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.doseChange).toMatchObject({
      id,
      doseValue: 1,
      doseUnit: "mg",
      effectiveFrom: "2026-09-08T08:00:00.000Z",
      note: "first step up",
      clientId: "step-a",
    });

    const audit = await prisma.auditLog.findFirst({
      where: { userId: USER_ID, action: "medication.glp1.update" },
      orderBy: { createdAt: "desc" },
    });
    expect(details(audit?.details)).toMatchObject({
      medicationId,
      doseChangeId: id,
      fields: ["doseValue", "effectiveFrom"],
      previous: { doseValue: 0.5, effectiveFrom: STEP.effectiveFrom },
    });
  });

  it("clears the note with null and seals a new one at rest", async () => {
    const medicationId = await seedMedication();
    const id = await step(medicationId);

    expect((await patch(medicationId, id, { note: "settled" })).status).toBe(
      200,
    );
    let row = await prisma.medicationDoseChange.findUniqueOrThrow({
      where: { id },
    });
    expect(row.note).toBeNull();
    expect(readNote(row.noteEncrypted, row.note)).toBe("settled");

    expect((await patch(medicationId, id, { note: null })).status).toBe(200);
    row = await prisma.medicationDoseChange.findUniqueOrThrow({
      where: { id },
    });
    expect(readNote(row.noteEncrypted, row.note)).toBeNull();
  });

  it("refuses an empty or invalid correction", async () => {
    const medicationId = await seedMedication();
    const id = await step(medicationId);
    expect((await patch(medicationId, id, {})).status).toBe(422);
    expect((await patch(medicationId, id, { doseValue: -1 })).status).toBe(422);
    // The client id names the step; it is not something to correct.
    expect((await patch(medicationId, id, { clientId: "other" })).status).toBe(
      422,
    );
  });

  it("removes the step and files what it removed", async () => {
    const medicationId = await seedMedication();
    const id = await step(medicationId);

    const res = await remove(medicationId, id);
    expect(res.status).toBe(200);
    expect(await prisma.medicationDoseChange.count()).toBe(0);
    expect((await remove(medicationId, id)).status).toBe(404);

    const audit = await prisma.auditLog.findFirst({
      where: { userId: USER_ID, action: "medication.glp1.doseChange.delete" },
    });
    expect(details(audit?.details)).toMatchObject({
      medicationId,
      doseChangeId: id,
      destroyedModel: "MedicationDoseChange",
      destroyedId: id,
      destroyedAt: STEP.effectiveFrom,
    });

    // A device that still holds the removed step as pending upload sends it
    // again under its client id. That must not bring the step back: the id
    // stays spent, answered 410 so the device drops its copy.
    const again = await postStep(medicationId, { ...STEP, clientId: "step-a" });
    expect(again.status).toBe(410);
    expect((await again.json()).meta?.errorCode).toBe(
      "glp1.doseChange.deleted",
    );
    expect(await prisma.medicationDoseChange.count()).toBe(0);

    // A new step under a new client id is created as usual.
    expect(
      (await postStep(medicationId, { ...STEP, clientId: "step-b" })).status,
    ).toBe(201);
  });

  it("answers 404 for a step of another medication or another account", async () => {
    const mine = await seedMedication();
    const otherMed = await seedMedication();
    const id = await step(mine);
    expect((await patch(otherMed, id, { doseValue: 1 })).status).toBe(404);
    expect((await remove(otherMed, id)).status).toBe(404);

    const foreignMed = await seedMedication(OTHER_ID);
    const foreign = await prisma.medicationDoseChange.create({
      data: {
        medicationId: foreignMed,
        effectiveFrom: new Date(STEP.effectiveFrom),
        doseValue: 1,
        doseUnit: "mg",
      },
    });
    expect((await patch(foreignMed, foreign.id, { doseValue: 2 })).status).toBe(
      404,
    );
    expect((await remove(foreignMed, foreign.id)).status).toBe(404);
    expect(
      (
        await prisma.medicationDoseChange.findUniqueOrThrow({
          where: { id: foreign.id },
        })
      ).doseValue,
    ).toBe(1);
  });
});

describe("PUT /api/medications/[id]/intake/[eventId] — injection site", () => {
  async function takenDose(medicationId: string): Promise<string> {
    const row = await prisma.medicationIntakeEvent.create({
      data: {
        userId: USER_ID,
        medicationId,
        scheduledFor: new Date("2026-09-01T08:00:00.000Z"),
        takenAt: new Date("2026-09-01T08:05:00.000Z"),
        source: "WEB",
      },
    });
    return row.id;
  }

  async function put(
    medicationId: string,
    eventId: string,
    body: unknown,
  ): Promise<Response> {
    const { PUT } =
      await import("@/app/api/medications/[id]/intake/[eventId]/route");
    return (PUT as Handler)(
      request(
        "PUT",
        `/api/medications/${medicationId}/intake/${eventId}`,
        body,
      ),
      { params: Promise.resolve({ id: medicationId, eventId }) },
    );
  }

  async function site(eventId: string): Promise<string | null> {
    return (
      await prisma.medicationIntakeEvent.findUniqueOrThrow({
        where: { id: eventId },
      })
    ).injectionSite;
  }

  it("sets an allowed site on a recorded dose, and clears it with null", async () => {
    const medicationId = await seedMedication();
    const eventId = await takenDose(medicationId);

    const res = await put(medicationId, eventId, {
      injectionSite: "ABDOMEN_LEFT",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.injectionSite).toBe("ABDOMEN_LEFT");
    expect(await site(eventId)).toBe("ABDOMEN_LEFT");

    expect(
      (await put(medicationId, eventId, { injectionSite: null })).status,
    ).toBe(200);
    expect(await site(eventId)).toBeNull();
  });

  it("leaves the site alone when the edit does not name it", async () => {
    const medicationId = await seedMedication();
    const eventId = await takenDose(medicationId);
    await put(medicationId, eventId, { injectionSite: "ABDOMEN_RIGHT" });
    await put(medicationId, eventId, {
      takenAt: "2026-09-01T08:10:00.000Z",
    });
    expect(await site(eventId)).toBe("ABDOMEN_RIGHT");
  });

  it("refuses a site outside the medication's allowed set", async () => {
    const medicationId = await seedMedication();
    const eventId = await takenDose(medicationId);
    const res = await put(medicationId, eventId, {
      injectionSite: "THIGH_LEFT",
    });
    expect(res.status).toBe(422);
    expect((await res.json()).meta.errorCode).toBe(
      "medications.intake.injection_site.disallowed",
    );
    expect(await site(eventId)).toBeNull();
  });

  it("refuses a site on a skipped dose or a medication that tracks none", async () => {
    const medicationId = await seedMedication();
    const skipped = await prisma.medicationIntakeEvent.create({
      data: {
        userId: USER_ID,
        medicationId,
        scheduledFor: new Date("2026-09-02T08:00:00.000Z"),
        skipped: true,
        source: "WEB",
      },
    });
    expect(
      (await put(medicationId, skipped.id, { injectionSite: "ABDOMEN_LEFT" }))
        .status,
    ).toBe(422);

    const tablet = await prisma.medication.create({
      data: { userId: USER_ID, name: "Tablet", dose: "10 mg" },
    });
    const dose = await takenDose(tablet.id);
    expect(
      (await put(tablet.id, dose, { injectionSite: "ABDOMEN_LEFT" })).status,
    ).toBe(422);
  });
});

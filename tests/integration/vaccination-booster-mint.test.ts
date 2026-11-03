/**
 * The booster mint — rung 2 — through the real routes, real Postgres, real
 * reminder engine.
 *
 * Every property here is about ROWS: how many reminders exist after a second
 * confirmation, whether the minted row lists as an ordinary Vorsorge reminder,
 * and whether logging the next dose moves the due date the mint set. None can
 * be answered from a fixture.
 *
 * The idempotence case is why the file exists: one antigen holds at most one
 * minted booster reminder, so a second confirmation re-anchors rather than
 * mints a second (WR-9). Fixture dates are relative — a test about "moves
 * forward" rots against a fixed calendar date.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { POST as createVaccination } from "@/app/api/vaccinations/route";
import { POST as mintBooster } from "@/app/api/vaccinations/[id]/booster/route";
import { GET as listReminders } from "@/app/api/measurement-reminders/route";

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

const OWNER_ID = "mint-owner";
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}
function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * DAY_MS);
}

async function seedSession() {
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: {
      id: OWNER_ID,
      username: "mint-owner",
      email: "mint-owner@example.test",
      timezone: "Europe/Berlin",
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: OWNER_ID,
      expiresAt: daysFromNow(7),
      mfaVerifiedAt: new Date(),
    },
  });
  cookieJar.set("healthlog_session", session.id);
}

async function createDose(body: unknown): Promise<{ id: string }> {
  const res = await createVaccination(
    new Request("http://localhost/api/vaccinations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}

function mint(vaccinationId: string, body: unknown): Promise<Response> {
  return mintBooster(
    new Request(`http://localhost/api/vaccinations/${vaccinationId}/booster`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: vaccinationId }) },
  );
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await seedSession();
});

describe("the booster mint writes an ordinary Vorsorge reminder", () => {
  it("mints one VORSORGE reminder keyed on the dose's primary antigen", async () => {
    const dose = await createDose({
      occurredAt: daysAgo(2).toISOString(),
      antigenSlug: "tetanus",
    });

    const res = await mint(dose.id, {
      intervalMonths: 120,
      label: "Tetanus booster",
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);

    const prisma = getPrismaClient();
    const reminders = await prisma.measurementReminder.findMany({
      where: { userId: OWNER_ID, deletedAt: null },
    });
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.origin).toBe("VORSORGE");
    expect(reminders[0]!.vaccinationAntigen).toBe("tetanus");
    expect(reminders[0]!.nextDueAt!.getTime()).toBeGreaterThan(Date.now());

    const stamped = await prisma.vaccinationRecord.findUniqueOrThrow({
      where: { id: dose.id },
    });
    expect(stamped.reminderId).toBe(reminders[0]!.id);
  });

  it("lists as an ordinary Vorsorge row with no new DTO field", async () => {
    const dose = await createDose({
      occurredAt: daysAgo(2).toISOString(),
      antigenSlug: "tetanus",
    });
    await mint(dose.id, { intervalMonths: 120, label: "Tetanus booster" });

    const res = await listReminders();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<Record<string, unknown> & { origin: string }>;
    };
    const minted = body.data.find((r) => r.origin === "VORSORGE");
    expect(minted).toBeDefined();
    expect(minted).not.toHaveProperty("vaccinationAntigen");
  });
});

describe("one antigen, at most one minted reminder (WR-9)", () => {
  it("re-anchors on a second confirmation rather than minting a second", async () => {
    const dose = await createDose({
      occurredAt: daysAgo(2).toISOString(),
      antigenSlug: "tetanus",
    });

    const first = await mint(dose.id, {
      intervalMonths: 120,
      label: "Tetanus booster",
    });
    expect(first.status).toBe(201);

    const second = await mint(dose.id, {
      intervalMonths: 60,
      label: "Tetanus booster (sooner)",
    });

    // The count is the property WR-9 breaks: a broken idempotence branch mints
    // a second row, and this is where it must go red.
    const reminders = await getPrismaClient().measurementReminder.findMany({
      where: {
        userId: OWNER_ID,
        deletedAt: null,
        vaccinationAntigen: "tetanus",
      },
    });
    expect(
      reminders,
      "one antigen holds at most one minted booster reminder",
    ).toHaveLength(1);
    // A re-anchor answers 200 and carries the second confirmation's edits.
    expect(second.status).toBe(200);
    expect(reminders[0]!.label).toBe("Tetanus booster (sooner)");
  });
});

describe("the whole activity-aware loop, through real routes", () => {
  it("mint → log the next dose → the matcher re-anchors the minted reminder", async () => {
    const first = await createDose({
      occurredAt: daysAgo(730).toISOString(),
      antigenSlug: "tetanus",
    });
    const mintRes = await mint(first.id, {
      intervalMonths: 120,
      label: "Tetanus booster",
    });
    expect(mintRes.status).toBe(201);
    const reminderId = (
      (await mintRes.json()) as { data: { reminder: { id: string } } }
    ).data.reminder.id;

    const prisma = getPrismaClient();
    const before = await prisma.measurementReminder.findUniqueOrThrow({
      where: { id: reminderId },
    });
    expect(before.lastSatisfiedAt).toBeNull();

    const occurredAt = daysAgo(1);
    const second = await createVaccination(
      new Request("http://localhost/api/vaccinations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          occurredAt: occurredAt.toISOString(),
          antigenSlug: "tetanus",
        }),
      }) as never,
    );
    expect(second.status).toBe(201);

    const after = await prisma.measurementReminder.findUniqueOrThrow({
      where: { id: reminderId },
    });
    expect(after.lastSatisfiedAt?.toISOString()).toBe(occurredAt.toISOString());
    expect(after.nextDueAt!.getTime()).toBeGreaterThan(
      before.nextDueAt!.getTime(),
    );
  });
});

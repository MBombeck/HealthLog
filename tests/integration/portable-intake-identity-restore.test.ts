/**
 * A portable restore attaches every dose to the medication it was recorded
 * against, and a seizure rescue dose to the intake it wrote.
 *
 * A portable file carries no row ids; it mints fresh ones on the way back.
 * Its intake events used to name their medication only by NAME, which is not
 * unique on an account (one drug in two strengths), so every dose of two
 * same-named drugs landed on the first one. And with the intake ids gone,
 * every rescue dose came back with no intake: deleting the seizure or the
 * dose later left the intake and its stock deduction standing, and the skip
 * report said nothing.
 *
 * Mutation check: drop `medicationRef` from the portable intake row and the
 * second drug comes back with no history (or the shared slot refuses the
 * insert); drop `ref` and the rescue dose's intake is null.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { parseBackupPayload } from "@/lib/validations/backup";
import { POST } from "./restore-job-driver";

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

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserData: vi.fn(),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

const SLOT = new Date("2026-11-20T07:00:00.000Z");

async function seed() {
  const prisma = getPrismaClient();
  const owner = await prisma.user.create({
    data: {
      username: "portable-intake-owner",
      email: "portable-intake-owner@example.test",
      role: "ADMIN",
    },
  });
  const userId = owner.id;
  const session = await prisma.session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);

  // One drug in two strengths, both taken in the same slot from the same
  // source: the live unique slot index only admits this when each dose is
  // on its own drug.
  const low = await prisma.medication.create({
    data: { userId, name: "Ibuprofen", dose: "200 mg" },
  });
  const high = await prisma.medication.create({
    data: { userId, name: "Ibuprofen", dose: "400 mg" },
  });
  await prisma.medicationIntakeEvent.create({
    data: {
      userId,
      medicationId: low.id,
      scheduledFor: SLOT,
      takenAt: SLOT,
      source: "WEB",
    },
  });
  const rescueIntake = await prisma.medicationIntakeEvent.create({
    data: {
      userId,
      medicationId: high.id,
      scheduledFor: SLOT,
      takenAt: SLOT,
      source: "WEB",
    },
  });
  await prisma.seizureEvent.create({
    data: {
      userId,
      onsetAt: SLOT,
      rescueDoses: {
        create: {
          userId,
          medicationId: high.id,
          medicationName: "Ibuprofen",
          givenAt: SLOT,
          intakeEventId: rescueIntake.id,
        },
      },
    },
  });
  return { userId, rescueIntakeId: rescueIntake.id };
}

async function restore(file: unknown, userId: string) {
  const prisma = getPrismaClient();
  const backup = await prisma.dataBackup.create({
    data: {
      userId,
      type: "PORTABLE_INTAKE_RESTORE",
      data: encrypt(JSON.stringify(file)),
    },
  });
  return POST(
    new Request(`http://localhost/api/admin/backups/${backup.id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "RESTORE" }),
    }) as unknown as Parameters<typeof POST>[0],
    { params: Promise.resolve({ id: backup.id }) },
  );
}

describe("a portable restore of intakes and rescue doses", () => {
  it("keeps each dose on its own drug and the rescue dose on its intake", async () => {
    const prisma = getPrismaClient();
    const { userId } = await seed();

    const portable = (await buildFullBackupPayload(prisma, userId)).payload;
    const file = parseBackupPayload(JSON.stringify(portable));
    // The premise: the portable file names no intake or medication id.
    expect(file.intakeEvents.every((e) => e.id === undefined)).toBe(true);
    expect(file.intakeEvents.every((e) => e.medicationId === undefined)).toBe(
      true,
    );

    const backup = await prisma.dataBackup.create({
      data: {
        userId,
        type: "PORTABLE_INTAKE_RESTORE",
        data: encrypt(JSON.stringify(file)),
      },
    });
    const response = await POST(
      new Request(`http://localhost/api/admin/backups/${backup.id}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "RESTORE" }),
      }) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: backup.id }) },
    );
    const text = await response.clone().text();
    expect(response.status, text).toBe(200);

    const meds = await prisma.medication.findMany({
      where: { userId },
      include: { intakeEvents: true },
    });
    const byDose = new Map(meds.map((m) => [m.dose, m]));
    expect(byDose.get("200 mg")?.intakeEvents).toHaveLength(1);
    expect(byDose.get("400 mg")?.intakeEvents).toHaveLength(1);

    const [dose] = await prisma.seizureRescueDose.findMany({
      where: { userId },
    });
    expect(dose?.intakeEventId).toBe(byDose.get("400 mg")!.intakeEvents[0]!.id);
    expect(dose?.medicationId).toBe(byDose.get("400 mg")!.id);
    // Nothing was dropped, so the report names nothing.
    expect(text).not.toContain("seizureIntakeReference");
  });

  it("reports a rescue dose whose intake the file does not carry", async () => {
    const prisma = getPrismaClient();
    const { userId, rescueIntakeId } = await seed();

    const portable = parseBackupPayload(
      JSON.stringify((await buildFullBackupPayload(prisma, userId)).payload),
    );
    const file = {
      ...portable,
      intakeEvents: portable.intakeEvents.filter(
        (e) => e.ref !== rescueIntakeId,
      ),
    };
    const response = await restore(file, userId);
    const text = await response.clone().text();
    expect(response.status, text).toBe(200);

    const [dose] = await prisma.seizureRescueDose.findMany({
      where: { userId },
    });
    expect(dose?.intakeEventId).toBeNull();
    expect(text).toContain("seizureIntakeReference");
  });
});

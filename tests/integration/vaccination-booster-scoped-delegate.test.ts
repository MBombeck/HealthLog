/**
 * `POST /api/vaccinations/{id}/booster` crosses a section boundary, and the
 * grant has to be on both sides of it.
 *
 * The operation is declared `("write", "profile")`, which is right for the act
 * — filing the Impfpass and arming the booster it suggests are one thing to
 * the person doing them. The ROW it mints is not: a `MeasurementReminder`
 * belongs to the measurements section, every direct route over that model says
 * so, and creating one there needs MANAGE. So a grant opening the health
 * background alone would otherwise produce a reminder on the owner's checkup
 * list that the delegate can neither read nor change through the section that
 * owns it.
 *
 * Refused rather than silently skipped: the reminder is the whole request, and
 * a 201 over a row that was never written would tell the person their booster
 * is planned while nothing rings.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { NextRequest } from "next/server";

import type { ShareDomain } from "@/lib/sharing/scope";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables, switchSessionTo } from "./setup";

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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const OWNER_ID = "booster-scope-owner";
const DELEGATE_ID = "booster-scope-delegate";

/** A catalogue antigen that carries a booster interval. */
const ANTIGEN = "tetanus";

let doseId: string;

async function seedRecords() {
  const prisma = getPrismaClient();
  for (const [id, name] of [
    [OWNER_ID, "owner"],
    [DELEGATE_ID, "delegate"],
  ] as const) {
    await prisma.user.create({
      data: {
        id,
        username: `booster-scope-${name}`,
        email: `booster-scope-${name}@example.test`,
        timezone: "UTC",
      },
    });
  }
  const dose = await prisma.vaccinationRecord.create({
    data: {
      userId: OWNER_ID,
      occurredAt: new Date("2026-03-01T00:00:00.000Z"),
      antigenSlug: ANTIGEN,
    },
  });
  doseId = dose.id;
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

async function switchInto(
  access: "WRITE" | "MANAGE",
  scope: ShareDomain[] | null,
) {
  const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
  const invited = await inviteGrant({
    grantorId: OWNER_ID,
    granteeId: DELEGATE_ID,
    access,
    scope,
  });
  await acceptGrant({ grantId: invited.id, granteeId: DELEGATE_ID });
  const session = await signIn(DELEGATE_ID);
  await switchSessionTo(session.id, OWNER_ID);
}

async function planBooster(): Promise<Response> {
  const { POST } = await import("@/app/api/vaccinations/[id]/booster/route");
  return POST(
    new NextRequest(`http://localhost/api/vaccinations/${doseId}/booster`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intervalMonths: 120, label: "Tetanus booster" }),
    }),
    { params: Promise.resolve({ id: doseId }) },
  );
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await seedRecords();
});

describe("planning a booster asks for the section the reminder lives in", () => {
  it("mints for the owner", async () => {
    await signIn(OWNER_ID);
    expect((await planBooster()).status).toBe(201);
    expect(
      await getPrismaClient().measurementReminder.count({
        where: { userId: OWNER_ID },
      }),
    ).toBe(1);
  });

  it("mints for a delegate holding both sections", async () => {
    await switchInto("WRITE", ["profile", "measurements"]);
    expect((await planBooster()).status).toBe(201);
    expect(
      await getPrismaClient().measurementReminder.count({
        where: { userId: OWNER_ID },
      }),
    ).toBe(1);
  });

  it("refuses a profile-only delegate and writes no reminder", async () => {
    await switchInto("WRITE", ["profile"]);
    const response = await planBooster();
    expect(response.status).toBe(403);
    const body = (await response.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("vaccination.booster-out-of-scope");
    expect(
      await getPrismaClient().measurementReminder.count({
        where: { userId: OWNER_ID },
      }),
      "no reminder was left on the owner's checkup list",
    ).toBe(0);
  });

  it("mints for a whole-record delegate", async () => {
    await switchInto("MANAGE", null);
    expect((await planBooster()).status).toBe(201);
  });
});

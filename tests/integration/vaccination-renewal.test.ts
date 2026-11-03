/**
 * The vaccination list carries each antigen's renewal state, read from the
 * booster reminder the person confirmed, and only to a caller whose grant
 * covers the measurements section that reminder lives in.
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

const OWNER_ID = "renewal-owner";
const DELEGATE_ID = "renewal-delegate";

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
        username: `renewal-${name}`,
        email: `renewal-${name}@example.test`,
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

async function listVaccinations(): Promise<{
  renewals: Array<{ antigen: string; state: string; daysUntil: number }> | null;
}> {
  const { GET } = await import("@/app/api/vaccinations/route");
  const res = await GET(new NextRequest("http://localhost/api/vaccinations"));
  expect(res.status).toBe(200);
  return (await res.json()).data;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await seedRecords();
});

describe("the vaccination list shows each antigen's renewal state (#1005)", () => {
  it("reads the booster the owner confirmed as current", async () => {
    await signIn(OWNER_ID);
    expect((await planBooster()).status).toBe(201);
    const { renewals } = await listVaccinations();
    expect(renewals).toHaveLength(1);
    expect(renewals![0]).toMatchObject({ antigen: ANTIGEN, state: "current" });
  });

  it("reads a booster whose date has passed as overdue", async () => {
    await signIn(OWNER_ID);
    expect((await planBooster()).status).toBe(201);
    await getPrismaClient().measurementReminder.updateMany({
      where: { userId: OWNER_ID },
      data: { nextDueAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) },
    });
    const { renewals } = await listVaccinations();
    expect(renewals![0]).toMatchObject({ antigen: ANTIGEN, state: "overdue" });
    expect(renewals![0]!.daysUntil).toBeLessThan(0);
  });

  it("claims nothing for an antigen without a confirmed booster", async () => {
    await signIn(OWNER_ID);
    const { renewals } = await listVaccinations();
    expect(renewals).toEqual([]);
  });

  it("never shows another account's booster", async () => {
    await signIn(OWNER_ID);
    expect((await planBooster()).status).toBe(201);
    cookieJar.clear();
    await signIn(DELEGATE_ID);
    const { renewals } = await listVaccinations();
    expect(renewals).toEqual([]);
  });

  it("withholds renewals from a grant that opened only the health background", async () => {
    await signIn(OWNER_ID);
    expect((await planBooster()).status).toBe(201);
    cookieJar.clear();
    await switchInto("WRITE", ["profile"]);
    const { renewals } = await listVaccinations();
    expect(renewals).toBeNull();
  });

  it("shows them to a grant that also covers measurements", async () => {
    await signIn(OWNER_ID);
    expect((await planBooster()).status).toBe(201);
    cookieJar.clear();
    await switchInto("WRITE", ["profile", "measurements"]);
    const { renewals } = await listVaccinations();
    expect(renewals).toHaveLength(1);
  });
});

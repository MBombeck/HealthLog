/**
 * Practitioner search covers the specialty column, against real Postgres.
 *
 * The property lives in SQL: the route's `where` OR filters name, practice
 * AND specialty case-insensitively. A mocked client cannot go red on it —
 * the filter it is meant to prove runs in the database, not in the handler.
 * So this seeds a row whose ONLY hit for "Zahn" is its specialty and asserts
 * the route returns it, plus a control row that must not come back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { GET as listPractitioners } from "@/app/api/practitioners/route";

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

const OWNER_ID = "practitioner-search-owner";

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function seedSession() {
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: {
      id: OWNER_ID,
      username: "practitioner-search-owner",
      email: "practitioner-search-owner@example.test",
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

async function search(q: string): Promise<{ id: string; name: string }[]> {
  const res = await listPractitioners(
    new Request(
      `http://localhost/api/practitioners?q=${encodeURIComponent(q)}`,
    ) as never,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { id: string; name: string }[] }).data;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await seedSession();
});

describe("practitioner search by specialty", () => {
  it("returns a row whose only 'Zahn' hit is its specialty", async () => {
    const prisma = getPrismaClient();
    // Name + practice deliberately hold no "Zahn"; the field does.
    await prisma.practitioner.create({
      data: {
        userId: OWNER_ID,
        name: "Dr. Meyer",
        practice: "Praxis am Park",
        specialty: "Zahnmedizin",
      },
    });
    // A control row that shares nothing with the query on any column.
    await prisma.practitioner.create({
      data: {
        userId: OWNER_ID,
        name: "Dr. Braun",
        practice: "Hausarztpraxis Nord",
        specialty: "Allgemeinmedizin",
      },
    });

    const hits = await search("Zahn");
    expect(hits).toHaveLength(1);
    expect(hits[0].name).toBe("Dr. Meyer");
  });

  it("still matches on name and practice, case-insensitively", async () => {
    const prisma = getPrismaClient();
    await prisma.practitioner.create({
      data: {
        userId: OWNER_ID,
        name: "Dr. Meyer",
        practice: "Praxis am Park",
        specialty: "Zahnmedizin",
      },
    });
    await prisma.practitioner.create({
      data: {
        userId: OWNER_ID,
        name: "Dr. Braun",
        practice: "Hausarztpraxis Nord",
        specialty: "Allgemeinmedizin",
      },
    });

    expect(await search("meyer")).toHaveLength(1);
    expect(await search("nord")).toHaveLength(1);
    expect(await search("medizin")).toHaveLength(2);
  });
});

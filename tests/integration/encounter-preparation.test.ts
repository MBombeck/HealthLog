/**
 * The window before a booked visit, through the real list route and real
 * Postgres.
 *
 * The unit test pins the rule over hand-built rows. What only the database can
 * answer is the read: that it looks at visits that took place (DONE, not
 * cancelled, not booked), that it ignores the list's own filters and paging,
 * that a soft-deleted visit is not an anchor, and that the practitioner's
 * specialty reaches the rule through the join.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { GET as listEncounters } from "@/app/api/encounters/route";
import type { EncounterListDTO } from "@/lib/encounters/dto";
import { shiftDateKey } from "@/lib/tz/format";

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

const OWNER_ID = "prep-owner";
const DAY_MS = 24 * 60 * 60 * 1000;

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * DAY_MS);
}

/** The local day of an instant on the owner's calendar. */
function berlinDay(at: Date): string {
  return at.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
}

async function seed() {
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: {
      id: OWNER_ID,
      username: "prep-owner",
      email: "prep-owner@example.test",
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

async function practitioner(name: string, specialty: string | null) {
  return getPrismaClient().practitioner.create({
    data: { userId: OWNER_ID, name, specialty },
  });
}

async function encounter(data: {
  occurredAt: Date;
  status?: "PLANNED" | "DONE" | "CANCELLED" | "NO_SHOW";
  kind?: "ROUTINE" | "SPECIALIST" | "THERAPY" | "OTHER";
  practitionerId?: string | null;
  deletedAt?: Date | null;
}) {
  return getPrismaClient().encounter.create({
    data: {
      userId: OWNER_ID,
      occurredAt: data.occurredAt,
      status: data.status ?? "DONE",
      kind: data.kind ?? "OTHER",
      practitionerId: data.practitionerId ?? null,
      deletedAt: data.deletedAt ?? null,
    },
  });
}

async function list(query = ""): Promise<EncounterListDTO> {
  const res = await listEncounters(
    new Request(`http://localhost/api/encounters${query}`) as never,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: EncounterListDTO }).data;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await seed();
});

describe("GET /api/encounters — the window before a booked visit", () => {
  it("starts at the same practitioner's last visit, not the last visit of any kind", async () => {
    const derm = await practitioner("Skin practice", "Dermatology");
    const internist = await practitioner(
      "Internal practice",
      "Internal medicine",
    );
    const dermVisit = await encounter({
      occurredAt: daysFromNow(-200),
      kind: "SPECIALIST",
      practitionerId: derm.id,
    });
    // The newer visit elsewhere the old rule anchored on.
    await encounter({
      occurredAt: daysFromNow(-5),
      kind: "SPECIALIST",
      practitionerId: internist.id,
    });
    const next = await encounter({
      occurredAt: daysFromNow(2),
      status: "PLANNED",
      kind: "SPECIALIST",
      practitionerId: derm.id,
    });

    const body = await list();
    const booked = body.upcoming.find((v) => v.id === next.id);
    expect(booked?.preparation).toEqual({
      from: berlinDay(dermVisit.occurredAt),
      to: berlinDay(next.occurredAt),
      basis: "practitioner",
      since: {
        id: dermVisit.id,
        occurredAt: dermVisit.occurredAt.toISOString(),
        kind: "SPECIALIST",
        practitionerName: "Skin practice",
        specialty: "Dermatology",
      },
    });
    // Only a booked visit carries one.
    expect(body.past.every((v) => v.preparation === null)).toBe(true);
  });

  it("matches a specialty across practitioners, through the join", async () => {
    const oldDerm = await practitioner("Former skin practice", "dermatology ");
    const newDerm = await practitioner("Skin practice", "Dermatology");
    const anchor = await encounter({
      occurredAt: daysFromNow(-300),
      kind: "SPECIALIST",
      practitionerId: oldDerm.id,
    });
    const next = await encounter({
      occurredAt: daysFromNow(3),
      status: "PLANNED",
      kind: "SPECIALIST",
      practitionerId: newDerm.id,
    });

    const booked = (await list()).upcoming.find((v) => v.id === next.id);
    expect(booked?.preparation?.basis).toBe("specialty");
    expect(booked?.preparation?.since?.id).toBe(anchor.id);
  });

  it("anchors only on a visit that took place and still exists", async () => {
    const derm = await practitioner("Skin practice", "Dermatology");
    await encounter({
      occurredAt: daysFromNow(-20),
      status: "CANCELLED",
      practitionerId: derm.id,
    });
    await encounter({
      occurredAt: daysFromNow(-30),
      status: "NO_SHOW",
      practitionerId: derm.id,
    });
    await encounter({
      occurredAt: daysFromNow(-40),
      practitionerId: derm.id,
      deletedAt: new Date(),
    });
    // Another booked visit with the same practice is not one that happened.
    await encounter({
      occurredAt: daysFromNow(1),
      status: "PLANNED",
      practitionerId: derm.id,
    });
    const next = await encounter({
      occurredAt: daysFromNow(9),
      status: "PLANNED",
      practitionerId: derm.id,
    });

    const booked = (await list()).upcoming.find((v) => v.id === next.id);
    expect(booked?.preparation).toEqual({
      from: shiftDateKey(berlinDay(new Date()), -90),
      to: berlinDay(next.occurredAt),
      basis: "default",
      since: null,
    });
  });

  it("reads the whole history, whatever the list was filtered to", async () => {
    const derm = await practitioner("Skin practice", "Dermatology");
    const anchor = await encounter({
      occurredAt: daysFromNow(-400),
      practitionerId: derm.id,
    });
    const next = await encounter({
      occurredAt: daysFromNow(4),
      status: "PLANNED",
      practitionerId: derm.id,
    });

    const from = daysFromNow(-1).toISOString();
    const body = await list(`?from=${encodeURIComponent(from)}`);
    expect(body.past).toEqual([]);
    expect(
      body.upcoming.find((v) => v.id === next.id)?.preparation?.since?.id,
    ).toBe(anchor.id);
  });

  it("leaves a cancelled upcoming visit without a window", async () => {
    const cancelled = await encounter({
      occurredAt: daysFromNow(5),
      status: "CANCELLED",
    });
    const booked = (await list()).upcoming.find((v) => v.id === cancelled.id);
    expect(booked?.preparation).toBeNull();
  });
});

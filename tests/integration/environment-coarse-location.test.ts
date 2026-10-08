/**
 * v1.39.4 — the environment module's coordinates are stored at 1 decimal
 * (about 11 km), against real Postgres.
 *
 *   - setting a home and adding a travel period store the coarse value, and
 *     the home answer carries it in the same shape as before (numbers);
 *   - a restore of a file written with 2-decimal coordinates stores them
 *     coarse;
 *   - the rounding block of migration 0361 coarsens rows written before it,
 *     and running it twice changes nothing more.
 *
 * v1.42 (#615): the locations are stored sealed, so the coarse value is
 * asserted on the opened sealed copy, and the readable columns are empty. The
 * rounding still happens before sealing; nothing finer is ever stored.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { PUT as putHome } from "@/app/api/environment/home/route";
import { POST as postTravel } from "@/app/api/environment/travel/route";
import { restoreEnvironmentData } from "@/lib/export/environment-backup";
import { openLocation } from "@/lib/environment/location-cipher";

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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const OWNER_ID = "environment-coarse-owner";

function jsonRequest(url: string, method: string, body: unknown) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  cookieJar.clear();
  headerJar.clear();
  await prisma.user.create({
    data: {
      id: OWNER_ID,
      username: OWNER_ID,
      email: `${OWNER_ID}@example.test`,
      timezone: "Europe/Berlin",
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: OWNER_ID,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      mfaVerifiedAt: new Date(),
    },
  });
  cookieJar.set("healthlog_session", session.id);
});

describe("environment coordinates at one decimal", () => {
  it("stores a home and a travel period coarse, and answers in the same shape", async () => {
    const home = await putHome(
      jsonRequest("http://localhost/api/environment/home", "PUT", {
        lat: 52.5163,
        lon: 13.3777,
        label: "Berlin, Germany",
        timezone: "Europe/Berlin",
      }),
    );
    expect(home.status).toBe(200);
    expect((await home.json()).data.home).toMatchObject({
      lat: 52.5,
      lon: 13.4,
    });
    const user = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: OWNER_ID },
    });
    expect([user.homeLat, user.homeLon, user.homeLabel]).toEqual([
      null,
      null,
      null,
    ]);
    expect(openLocation(user.homeLocationEncrypted!)).toEqual({
      lat: 52.5,
      lon: 13.4,
      label: "Berlin, Germany",
    });

    const travel = await postTravel(
      jsonRequest("http://localhost/api/environment/travel", "POST", {
        startDate: "2026-08-01",
        endDate: "2026-08-10",
        lat: 48.13743,
        lon: 11.57549,
        label: "Munich, Germany",
      }),
    );
    expect(travel.status).toBe(201);
    expect((await travel.json()).data).toMatchObject({ lat: 48.1, lon: 11.6 });
    const stored = await getPrismaClient().environmentTravelLocation.findMany({
      where: { userId: OWNER_ID },
    });
    expect(stored.map((t) => [t.lat, t.lon, t.label])).toEqual([
      [null, null, null],
    ]);
    expect(stored.map((t) => openLocation(t.locationEncrypted!))).toEqual([
      { lat: 48.1, lon: 11.6, label: "Munich, Germany" },
    ]);
  });

  it("restores a file written with two-decimal coordinates at one decimal", async () => {
    const prisma = getPrismaClient();
    await prisma.$transaction((tx) =>
      restoreEnvironmentData(tx, OWNER_ID, {
        environmentTravelLocations: [
          {
            startDate: "2026-08-01",
            endDate: "2026-08-10",
            lat: 48.14,
            lon: 11.58,
            label: "Munich, Germany",
          },
        ],
        environmentContexts: [
          {
            date: "2026-08-02",
            lat: 48.14,
            lon: 11.58,
            locationLabel: "Munich, Germany",
            source: "TRAVEL",
          },
        ],
      }),
    );
    const travel = await prisma.environmentTravelLocation.findMany({
      where: { userId: OWNER_ID },
    });
    const days = await prisma.environmentContext.findMany({
      where: { userId: OWNER_ID },
    });
    expect(travel.map((t) => openLocation(t.locationEncrypted!))).toEqual([
      { lat: 48.1, lon: 11.6, label: "Munich, Germany" },
    ]);
    expect(days.map((d) => openLocation(d.locationEncrypted!))).toEqual([
      { lat: 48.1, lon: 11.6, label: "Munich, Germany" },
    ]);
    expect(days.map((d) => [d.lat, d.lon, d.locationLabel])).toEqual([
      [null, null, null],
    ]);
  });

  it("coarsens rows written before migration 0361, idempotently", async () => {
    const prisma = getPrismaClient();
    await prisma.user.update({
      where: { id: OWNER_ID },
      data: { homeLat: 52.52, homeLon: 13.38 },
    });
    await prisma.environmentTravelLocation.create({
      data: {
        userId: OWNER_ID,
        startDate: "2026-08-01",
        endDate: "2026-08-10",
        lat: 48.14,
        lon: 11.58,
        label: "Munich, Germany",
      },
    });
    await prisma.environmentContext.create({
      data: {
        userId: OWNER_ID,
        date: "2026-08-02",
        lat: -33.87,
        lon: 151.21,
        locationLabel: "Sydney, Australia",
        source: "TRAVEL",
      },
    });

    const sql = readFileSync(
      join(
        __dirname,
        "../../prisma/migrations/0361_encrypt_route_geometry_and_practitioner_contact/migration.sql",
      ),
      "utf8",
    );
    const statements = sql
      .slice(sql.indexOf('UPDATE "users"'))
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements).toHaveLength(3);

    for (let pass = 0; pass < 2; pass++) {
      for (const statement of statements) {
        await prisma.$executeRawUnsafe(statement);
      }
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: OWNER_ID },
      });
      expect([user.homeLat, user.homeLon]).toEqual([52.5, 13.4]);
      const travel = await prisma.environmentTravelLocation.findFirstOrThrow({
        where: { userId: OWNER_ID },
      });
      expect([travel.lat, travel.lon]).toEqual([48.1, 11.6]);
      const day = await prisma.environmentContext.findFirstOrThrow({
        where: { userId: OWNER_ID },
      });
      expect([day.lat, day.lon]).toEqual([-33.9, 151.2]);
    }
  });
});

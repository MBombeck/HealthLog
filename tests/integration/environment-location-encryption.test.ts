/**
 * v1.42 (#615) — the environment locations sealed at rest, against real
 * Postgres with the migrated schema (0381, 0382).
 *
 *   - the writers (home, period) store only the sealed copy, the overview
 *     answers readable, and the air-quality switch round-trips through its
 *     route;
 *   - the boot-time backfill finds the accounts still holding a readable
 *     home, period or day, seals each, clears the readable columns, and
 *     converges (a second pass and a second discovery find nothing);
 *   - the backup carries the location readable in a portable file and sealed
 *     in a disaster-recovery file, and both restore to a location that opens
 *     to the same coarse place, with the air-quality values of the day;
 *   - the data wipe clears the sealed home with the rest.
 */
import { Buffer } from "node:buffer";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PUT as putHome } from "@/app/api/environment/home/route";
import { POST as postTravel } from "@/app/api/environment/travel/route";
import { PATCH as patchPreferences } from "@/app/api/environment/preferences/route";
import { GET as getOverview } from "@/app/api/environment/route";
import { setGlobalBoss } from "@/lib/jobs/boss-instance";
import {
  enqueueBootTimeFreeTextEncryptionBackfill,
  runFreeTextEncryptionBackfillForUser,
} from "@/lib/jobs/free-text-encryption-backfill";
import { openLocation, sealLocation } from "@/lib/environment/location-cipher";
import {
  buildEnvironmentBackupSection,
  restoreEnvironmentData,
  type EnvironmentRestoreInput,
} from "@/lib/export/environment-backup";

/** A section as a file carries it: through JSON and back. */
function throughFile(section: unknown): EnvironmentRestoreInput {
  return JSON.parse(JSON.stringify(section)) as EnvironmentRestoreInput;
}

import type { RestoreSkipLog } from "@/lib/export/restore-skips";
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

const OWNER = "env-sealed-owner";

function jsonRequest(url: string, method: string, body: unknown) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

async function seedUser(id: string) {
  await getPrismaClient().user.create({
    data: {
      id,
      username: id,
      email: `${id}@example.test`,
      timezone: "Europe/Berlin",
    },
  });
}

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  cookieJar.clear();
  headerJar.clear();
  await seedUser(OWNER);
  const session = await prisma.session.create({
    data: {
      userId: OWNER,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      mfaVerifiedAt: new Date(),
    },
  });
  cookieJar.set("healthlog_session", session.id);
});

afterEach(() => {
  setGlobalBoss(null as never);
});

describe("environment writers and the overview", () => {
  it("store the sealed copy only and answer readable", async () => {
    const prisma = getPrismaClient();
    expect(
      (
        await putHome(
          jsonRequest("http://localhost/api/environment/home", "PUT", {
            lat: 51.4818,
            lon: 7.2162,
            label: "Bochum, Germany",
            timezone: "Europe/Berlin",
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await postTravel(
          jsonRequest("http://localhost/api/environment/travel", "POST", {
            startDate: "2026-08-01",
            endDate: "2026-08-10",
            lat: 38.7223,
            lon: -9.1393,
            label: "Lisbon, Portugal",
          }),
        )
      ).status,
    ).toBe(201);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: OWNER } });
    expect([user.homeLat, user.homeLon, user.homeLabel]).toEqual([
      null,
      null,
      null,
    ]);
    const travel = await prisma.environmentTravelLocation.findFirstOrThrow({
      where: { userId: OWNER },
    });
    expect([travel.lat, travel.lon, travel.label]).toEqual([null, null, null]);
    // No readable trace of either place anywhere in the two rows.
    expect(
      JSON.stringify({ ...user, homeLocationEncrypted: null }),
    ).not.toMatch(/Bochum/);

    const overview = (await (await getOverview()).json()).data;
    expect(overview.home).toMatchObject({
      lat: 51.5,
      lon: 7.2,
      label: "Bochum, Germany",
    });
    expect(overview.travel).toEqual([
      expect.objectContaining({
        startDate: "2026-08-01",
        lat: 38.7,
        lon: -9.1,
        label: "Lisbon, Portugal",
      }),
    ]);
    expect(overview.airQuality).toMatchObject({
      enabled: true,
      operatorDisabled: false,
      days: 0,
    });
    expect(overview.attributions.length).toBe(3);
  });

  it("turns the air-quality part off and on through its route", async () => {
    const prisma = getPrismaClient();
    const off = await patchPreferences(
      jsonRequest("http://localhost/api/environment/preferences", "PATCH", {
        airQualityEnabled: false,
      }),
    );
    expect(off.status).toBe(200);
    expect((await off.json()).data).toEqual({
      airQualityEnabled: false,
      operatorDisabled: false,
    });
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: OWNER } }))
        .environmentAirQualityEnabled,
    ).toBe(false);

    const bad = await patchPreferences(
      jsonRequest("http://localhost/api/environment/preferences", "PATCH", {
        airQualityEnabled: "yes",
        userId: "someone-else",
      }),
    );
    expect(bad.status).toBe(422);
  });

  it("leaves the air-quality values of a stored day out of the overview while off", async () => {
    const prisma = getPrismaClient();
    await prisma.environmentContext.create({
      data: {
        userId: OWNER,
        date: "2026-10-06",
        source: "HOME",
        locationEncrypted: sealLocation({ lat: 51.5, lon: 7.2, label: "Home" }),
        tempMin: 21,
        pm25Mean: 12,
        eaqiMax: 85,
        pollenGrassMax: 70,
        aqHours: 24,
        aqDomain: "cams_europe",
        aqFetchedAt: new Date(),
      },
    });
    const on = (await (await getOverview()).json()).data;
    expect(on.latestDay).toMatchObject({
      date: "2026-10-06",
      tempMin: 21,
      airQuality: { pm25Mean: 12, eaqiMax: 85, pollen: { grass: 70 } },
    });
    expect(on.airQuality).toMatchObject({ days: 1, domain: "cams_europe" });

    await prisma.user.update({
      where: { id: OWNER },
      data: { environmentAirQualityEnabled: false },
    });
    const off = (await (await getOverview()).json()).data;
    expect(off.latestDay.airQuality).toBeNull();
    expect(off.attributions.length).toBe(1);
  });
});

describe("the encryption backfill (real Postgres)", () => {
  it("discovers, seals, clears and converges", async () => {
    const prisma = getPrismaClient();
    await seedUser("env-other");
    const stamp = new Date("2026-03-01T10:00:00.000Z");
    await prisma.user.update({
      where: { id: OWNER },
      data: { homeLat: 51.5, homeLon: 7.2, homeLabel: "Bochum, Germany" },
    });
    await prisma.environmentTravelLocation.create({
      data: {
        userId: OWNER,
        startDate: "2026-08-01",
        endDate: "2026-08-10",
        lat: 38.7,
        lon: -9.1,
        label: "Lisbon, Portugal",
        updatedAt: stamp,
      },
    });
    await prisma.environmentContext.create({
      data: {
        userId: OWNER,
        date: "2026-08-02",
        lat: 38.7,
        lon: -9.1,
        locationLabel: "Lisbon, Portugal",
        source: "TRAVEL",
      },
    });

    const sent: string[] = [];
    setGlobalBoss({
      send: async (_q: string, payload: { userId?: string }) => {
        if (payload.userId) sent.push(payload.userId);
        return "job";
      },
    } as never);
    const discovery = await enqueueBootTimeFreeTextEncryptionBackfill();
    expect(discovery.error).toBeNull();
    expect(sent).toEqual([OWNER]);

    const summary = await runFreeTextEncryptionBackfillForUser(OWNER);
    expect(summary).toMatchObject({
      homeLocationsMigrated: 1,
      travelLocationsMigrated: 1,
      dayLocationsMigrated: 1,
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: OWNER } });
    expect(user.homeLat).toBeNull();
    expect(openLocation(user.homeLocationEncrypted!)).toEqual({
      lat: 51.5,
      lon: 7.2,
      label: "Bochum, Germany",
    });
    const travel = await prisma.environmentTravelLocation.findFirstOrThrow({
      where: { userId: OWNER },
    });
    expect(travel.lat).toBeNull();
    expect(travel.updatedAt).toEqual(stamp);
    expect(openLocation(travel.locationEncrypted!).label).toBe(
      "Lisbon, Portugal",
    );
    const day = await prisma.environmentContext.findFirstOrThrow({
      where: { userId: OWNER },
    });
    expect([day.lat, day.lon, day.locationLabel]).toEqual([null, null, null]);
    expect(openLocation(day.locationEncrypted!).lat).toBe(38.7);

    // Converged: nothing readable is left to find.
    expect(await runFreeTextEncryptionBackfillForUser(OWNER)).toMatchObject({
      homeLocationsMigrated: 0,
      travelLocationsMigrated: 0,
      dayLocationsMigrated: 0,
    });
    sent.length = 0;
    await enqueueBootTimeFreeTextEncryptionBackfill();
    expect(sent).toEqual([]);
    const remaining = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT (SELECT count(*) FROM users WHERE home_lat IS NOT NULL)
           + (SELECT count(*) FROM environment_travel_locations WHERE lat IS NOT NULL)
           + (SELECT count(*) FROM environment_contexts WHERE lat IS NOT NULL) AS n`;
    expect(Number(remaining[0].n)).toBe(0);
  });
});

describe("the environment backup with sealed locations", () => {
  async function seedDay() {
    const prisma = getPrismaClient();
    await prisma.environmentTravelLocation.create({
      data: {
        userId: OWNER,
        startDate: "2026-08-01",
        endDate: "2026-08-10",
        locationEncrypted: sealLocation({
          lat: 38.7,
          lon: -9.1,
          label: "Lisbon, Portugal",
        }),
      },
    });
    await prisma.environmentContext.create({
      data: {
        userId: OWNER,
        date: "2026-08-02",
        source: "TRAVEL",
        locationEncrypted: sealLocation({
          lat: 38.7,
          lon: -9.1,
          label: "Lisbon, Portugal",
        }),
        tempMin: 20.5,
        pm25Mean: 7.5,
        o3Max8h: 96,
        pollenOliveMax: null,
        pollenGrassMax: 4,
        aqDomain: "cams_europe",
        aqHours: 24,
        aqFetchedAt: new Date("2026-08-05T02:10:00.000Z"),
      },
    });
  }

  it("writes the location readable in a portable file and restores it sealed", async () => {
    const prisma = getPrismaClient();
    await seedDay();
    const section = await buildEnvironmentBackupSection(prisma, OWNER, {
      purpose: "portable-export",
    });
    const [day] = section.environmentContexts;
    expect(day).toMatchObject({
      lat: 38.7,
      lon: -9.1,
      locationLabel: "Lisbon, Portugal",
      pm25Mean: 7.5,
      pollenOliveMax: null,
      aqFetchedAt: "2026-08-05T02:10:00.000Z",
    });
    expect(day).not.toHaveProperty("locationEncrypted");
    expect(section.environmentTravelLocations[0]).toMatchObject({
      lat: 38.7,
      label: "Lisbon, Portugal",
    });

    const parsed = throughFile(section);
    await prisma.$transaction((tx) =>
      restoreEnvironmentData(tx, OWNER, parsed),
    );
    const restored = await prisma.environmentContext.findFirstOrThrow({
      where: { userId: OWNER },
    });
    expect([restored.lat, restored.locationLabel]).toEqual([null, null]);
    expect(openLocation(restored.locationEncrypted!)).toEqual({
      lat: 38.7,
      lon: -9.1,
      label: "Lisbon, Portugal",
    });
    expect(restored).toMatchObject({
      pm25Mean: 7.5,
      o3Max8h: 96,
      pollenGrassMax: 4,
      aqHours: 24,
      aqDomain: "cams_europe",
    });
    expect(restored.aqFetchedAt).toEqual(new Date("2026-08-05T02:10:00.000Z"));
  });

  it("carries the sealed value verbatim in a disaster-recovery file", async () => {
    const prisma = getPrismaClient();
    await seedDay();
    const before = await prisma.environmentContext.findFirstOrThrow({
      where: { userId: OWNER },
    });
    const section = await buildEnvironmentBackupSection(prisma, OWNER, {
      purpose: "disaster-recovery",
    });
    const [day] = section.environmentContexts;
    expect(day.lat).toBeNull();
    expect(day.locationEncrypted).toBe(
      Buffer.from(before.locationEncrypted!).toString("base64"),
    );
    const parsed = throughFile(section);
    await prisma.$transaction((tx) =>
      restoreEnvironmentData(tx, OWNER, parsed),
    );
    const after = await prisma.environmentContext.findFirstOrThrow({
      where: { userId: OWNER },
    });
    expect(
      Buffer.from(after.locationEncrypted!).equals(
        Buffer.from(before.locationEncrypted!),
      ),
    ).toBe(true);
  });

  it("keeps a sealed location this host cannot open sealed, and reports it", async () => {
    const prisma = getPrismaClient();
    const damaged = Buffer.from([2, 2, 118, 49, ...new Array(40).fill(7)]);
    const skips: RestoreSkipLog = [];
    await prisma.$transaction((tx) =>
      restoreEnvironmentData(
        tx,
        OWNER,
        {
          environmentTravelLocations: [
            {
              startDate: "2026-08-01",
              endDate: "2026-08-10",
              lat: null,
              lon: null,
              label: null,
              locationEncrypted: damaged.toString("base64"),
            },
          ],
          environmentContexts: [
            {
              date: "2026-08-02",
              lat: null,
              lon: null,
              locationLabel: null,
              source: "TRAVEL",
              locationEncrypted: damaged.toString("base64"),
              tempMin: 20,
            },
          ],
        },
        skips,
      ),
    );
    expect(skips.map((s) => [s.catalogue, s.key]).sort()).toEqual([
      ["environmentLocationCiphertext", "environmentContexts.2026-08-02"],
      [
        "environmentLocationCiphertext",
        "environmentTravelLocations.2026-08-01..2026-08-10",
      ],
    ]);
    const period = await prisma.environmentTravelLocation.findFirstOrThrow({
      where: { userId: OWNER },
    });
    expect(Buffer.from(period.locationEncrypted!).equals(damaged)).toBe(true);
  });

  it("restores a file from before air quality as a day never fetched", async () => {
    const prisma = getPrismaClient();
    await prisma.$transaction((tx) =>
      restoreEnvironmentData(tx, OWNER, {
        environmentTravelLocations: [],
        environmentContexts: [
          {
            date: "2026-01-02",
            lat: 51.5,
            lon: 7.2,
            locationLabel: "Bochum, Germany",
            source: "HOME",
            tempMin: 1,
          },
        ],
      }),
    );
    const day = await prisma.environmentContext.findFirstOrThrow({
      where: { userId: OWNER },
    });
    expect(day.aqFetchedAt).toBeNull();
    expect(day.pm25Mean).toBeNull();
    expect(openLocation(day.locationEncrypted!).label).toBe("Bochum, Germany");
  });
});

describe("the data wipe", () => {
  it("clears the sealed home, the periods and the days, and resets the switch", async () => {
    const prisma = getPrismaClient();
    await prisma.user.update({
      where: { id: OWNER },
      data: {
        homeLocationEncrypted: sealLocation({
          lat: 51.5,
          lon: 7.2,
          label: "Bochum, Germany",
        }),
        environmentAirQualityEnabled: false,
      },
    });
    await prisma.environmentContext.create({
      data: {
        userId: OWNER,
        date: "2026-08-02",
        source: "HOME",
        locationEncrypted: sealLocation({ lat: 51.5, lon: 7.2, label: "x" }),
      },
    });
    const { DELETE } = await import("@/app/api/settings/data/route");
    const response = await DELETE(
      new Request("http://localhost/api/settings/data", {
        method: "DELETE",
        body: JSON.stringify({ confirm: "DELETE" }),
      }) as never,
    );
    expect(response.status).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: OWNER } });
    expect(user.homeLocationEncrypted).toBeNull();
    expect(user.environmentAirQualityEnabled).toBe(true);
    expect(
      await prisma.environmentContext.count({ where: { userId: OWNER } }),
    ).toBe(0);
  });
});
